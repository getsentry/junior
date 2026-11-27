// The ingress of the core Turn engine. When `JUNIOR_TURN_ENGINE` is `core`,
// main's mailbox send calls this instead of writing the mailbox: it maps the
// mailbox message to a core input and schedules it. So each Source that
// sends through the mailbox reaches core with no change of its own.
import {
  createEventSource,
  createSlackSource,
  createWebSource,
  type Actor,
  type Source,
} from "@sentry/junior-plugin-api";
import { createSlackActor } from "@/chat/actor";
import { getChatConfig } from "@/chat/config";
import { getConversationStore } from "@/chat/db";
import {
  getDispatchIdForConversation,
  getDispatchRecord,
} from "@/chat/agent-dispatch/store";
import { isTopLevel } from "@/chat/conversations/kind-behavior";
import { legacyWebMailboxMetadataSchema } from "@/chat/conversations/web-mailbox";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { isEventMailboxMetadata } from "@/chat/events/mailbox-metadata";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import { readSlackRawMessageContext } from "@/chat/slack/context";
import {
  conversationVisibilityFromSlackChannelType,
  resolveSlackChannelTypeFromMessage,
} from "@/chat/slack/conversation-context";
import type {
  AppendInboundMessageResult,
  InboundMessage,
} from "@/chat/task-execution/state";
import type { TurnDestination } from "@/db/schema/turn-inbox";
import { scheduleInput } from "@/core/turn/schedule";
import { createEngineContext } from "./engine-context";
import { turnGroupKey } from "./group-key";
import { turnInputPayloadSchema } from "./input-payload";

/** Who sent a mailbox message, where from, and where its answer goes. */
type InputFacts = {
  actor: Actor;
  /** Undefined when the message names no Identity of its own. */
  actorIdentityId: string | undefined;
  destination: TurnDestination | null;
  source: Source;
  text: string;
};

function slackFacts(message: InboundMessage): InputFacts {
  const { destination } = message;
  const { authorId, metadata } = message.input;
  if (destination?.platform !== "slack" || !authorId) {
    throw new Error("Slack input requires a Slack Destination and an author");
  }
  // The Slack message as ingress saved it, with the event's raw fields.
  const slackMessage = metadata?.["message"];
  const raw = readSlackRawMessageContext(slackMessage);
  // A top-level message starts its own thread, so its ts is the thread.
  const threadTs = raw?.threadTs ?? raw?.messageTs;
  return {
    actor: createSlackActor(destination.teamId, authorId, null),
    actorIdentityId: message.input.authorIdentityId,
    destination: { ...destination, ...(threadTs ? { threadTs } : undefined) },
    source: createSlackSource({
      channelId: destination.channelId,
      messageTs: raw?.messageTs,
      teamId: destination.teamId,
      threadTs,
      visibility:
        conversationVisibilityFromSlackChannelType(
          resolveSlackChannelTypeFromMessage(slackMessage),
        ) ?? "private",
    }),
    text: message.input.text,
  };
}

// Main's rule: a web Source takes its Conversation's privacy, and a child
// with no stored privacy is private, because its parent's task can carry the
// root's private content.
async function webVisibility(
  conversationId: string,
): Promise<"private" | "public"> {
  const conversation = await getConversationStore().get({ conversationId });
  const visibility =
    !conversation || isTopLevel(conversation)
      ? conversation?.visibility
      : (conversation.visibility ?? "private");
  return visibility === "private" ? "private" : "public";
}

async function webFacts(message: InboundMessage): Promise<InputFacts> {
  const metadata = legacyWebMailboxMetadataSchema.parse(message.input.metadata);
  return {
    actor: {
      platform: "web",
      userId: metadata.authorUserId,
      email: metadata.authorEmail,
      ...(metadata.authorFullName
        ? { fullName: metadata.authorFullName }
        : undefined),
      ...(metadata.authorUserName
        ? { userName: metadata.authorUserName }
        : undefined),
    },
    actorIdentityId: message.input.authorIdentityId,
    // The dashboard reads the answer from the Conversation history.
    destination: null,
    source: createWebSource(
      message.conversationId,
      await webVisibility(message.conversationId),
    ),
    text: message.input.text,
  };
}

function eventFacts(message: InboundMessage): InputFacts {
  const { metadata } = message.input;
  if (!isEventMailboxMetadata(metadata)) {
    throw new Error("Event input has invalid metadata");
  }
  return {
    actor: EVENT_SYSTEM_ACTOR,
    actorIdentityId: message.input.authorIdentityId ?? SYSTEM_IDENTITY_ID,
    destination: null,
    source: createEventSource(metadata.event),
    text: message.input.text,
  };
}

// A dispatch message only names its dispatch, and the dispatch record has
// the request.
async function dispatchFacts(message: InboundMessage): Promise<InputFacts> {
  const dispatchId = getDispatchIdForConversation(message.conversationId);
  const dispatch = dispatchId && (await getDispatchRecord(dispatchId));
  if (!dispatch) {
    throw new Error(`No dispatch for ${message.conversationId}`);
  }
  return {
    actor: dispatch.actor,
    actorIdentityId: message.input.authorIdentityId ?? SYSTEM_IDENTITY_ID,
    destination: dispatch.destination,
    source: dispatch.source,
    text: dispatch.input,
  };
}

async function inputFacts(message: InboundMessage): Promise<InputFacts> {
  switch (message.source) {
    case "slack":
      return slackFacts(message);
    case "web":
      return await webFacts(message);
    case "event":
      return eventFacts(message);
    case "plugin":
      return await dispatchFacts(message);
    default:
      throw new Error(`Core has no input for ${message.source} messages`);
  }
}

/**
 * Schedules a mailbox message as a core input. The message id is the
 * idempotency key, so a redelivery writes nothing and is a `duplicate`.
 * `startDelayMs` holds a new Turn so that inputs sent soon after join it, as
 * main's delayed wake does. Call it outside a transaction, as
 * `scheduleInput` requires.
 */
export async function scheduleInboundMessage(
  message: InboundMessage,
  options: { startDelayMs?: number | undefined } = {},
): Promise<AppendInboundMessageResult> {
  const facts = await inputFacts(message);
  if (!facts.actorIdentityId) {
    throw new Error(`${message.source} input has no author Identity`);
  }
  const engineCtx = createEngineContext(getChatConfig());
  const { duplicate } = await scheduleInput(engineCtx, {
    conversationId: message.conversationId,
    actorIdentityId: facts.actorIdentityId,
    groupKey: turnGroupKey(facts.actorIdentityId, facts.source),
    payload: turnInputPayloadSchema.parse({
      text: facts.text,
      actor: facts.actor,
    }),
    idempotencyKey: message.inboundMessageId,
    sentAt: new Date(message.createdAtMs),
    source: facts.source,
    destination: facts.destination,
    delivery: message.delivery,
    ...(message.traceContext
      ? { traceContext: message.traceContext }
      : undefined),
    startDelayMs: options.startDelayMs,
  });
  return { status: duplicate ? "duplicate" : "appended" };
}
