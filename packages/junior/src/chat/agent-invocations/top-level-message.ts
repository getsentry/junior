/**
 * Agent messages between top-level agents: root Conversations that are not
 * in the same agent tree. A message wakes the target like any other Event.
 * The target runs it as the event system Actor, so the sender's Actor and
 * credentials never reach the target. It joins a running Turn of the target
 * only when that Turn already acts for the sender's Actor with the same
 * credentials.
 */
import type { StateAdapter } from "chat";
import type { Actor } from "@/chat/actor";
import {
  canAccessConversation,
  readConversationAccessFromSql,
} from "@/api/conversations/access";
import { getConversationStore, getDb } from "@/chat/db";
import {
  EVENT_WAIT_MS,
  isEventMailboxMetadata,
  type EventMailboxMetadata,
} from "@/chat/events/notification";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import { renderDataTag } from "@/chat/input-tags";
import { readLeadSpace } from "@/chat/lead/conversation";
import { readActorIdentity } from "@/chat/plugins/viewer";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { InboundMessage } from "@/chat/task-execution/store";
import { enqueueAutomatedInput } from "@/chat/conversations/session-stop";
import { AgentMessageTargetError } from "./errors";
import { readSteeringSender, type SteeringSender } from "./steering-sender";
import { PARENT_AGENT_TARGET } from "./types";

const AGENT_MESSAGE_EVENT_NAMESPACE = "junior";
/** Event type of a message from another top-level agent. */
const TOP_LEVEL_AGENT_MESSAGE_EVENT_TYPE = "agent.top_level_message";

/**
 * Check that a top-level agent can message another top-level agent under
 * `policies/conversation-access.md`. Public agents can message each other.
 * A private agent can message only agents at its own Destination, such as
 * another thread in the same private Slack channel, or in its own private
 * Space. A Space's Lead messages a root outside its Space only when the
 * member who asked is a Participant of that root.
 * Every target that the sender cannot reach gets the same error, so the
 * error does not show that a private Conversation exists.
 */
async function requireTopLevelAgentAccess(args: {
  askingActor?: Actor | undefined;
  senderConversationId: string;
  to: string;
}): Promise<void> {
  const notReachable = new AgentMessageTargetError(
    `"${args.to}" is not "${PARENT_AGENT_TARGET}", a child agent of this conversation, or a top-level agent that you can message`,
  );
  if (args.to === args.senderConversationId) {
    throw new AgentMessageTargetError(`"${args.to}" is this conversation`);
  }
  const conversationStore = getConversationStore();
  const [senderConversation, target] = await Promise.all([
    conversationStore.get({ conversationId: args.senderConversationId }),
    conversationStore.get({ conversationId: args.to }),
  ]);
  if (senderConversation?.parentConversationId) {
    throw new AgentMessageTargetError(
      `"${args.to}" is not "${PARENT_AGENT_TARGET}" or a child agent of this conversation`,
    );
  }
  if (!target || target.parentConversationId) {
    throw notReachable;
  }
  const access = await readConversationAccessFromSql(getDb(), [
    args.senderConversationId,
    args.to,
  ]);
  const sender = access.get(args.senderConversationId);
  const receiver = access.get(args.to);
  if (
    !sender ||
    !receiver ||
    !canAccessConversation({ requester: sender, target: receiver })
  ) {
    throw notReachable;
  }
  // A message writes the sender's data into the target. Private data never
  // enters a public Conversation. The target is public, so this error shows
  // nothing private.
  if (receiver.visibility === "public" && sender.visibility !== "public") {
    throw new AgentMessageTargetError(
      `"${args.to}" is a public conversation and this conversation is private. A private conversation can message only conversations in its own channel, DM, or private Space`,
    );
  }
  const leadSpaceId = (await readLeadSpace(args.senderConversationId))?.id;
  if (leadSpaceId && target.spaceId !== leadSpaceId) {
    const person = args.askingActor
      ? (await readActorIdentity(args.askingActor))?.user
      : undefined;
    const personAccess = person
      ? (await readConversationAccessFromSql(getDb(), [args.to], person)).get(
          args.to,
        )
      : undefined;
    if (!personAccess?.isParticipant) {
      throw new AgentMessageTargetError(
        `"${args.to}" is outside this Space. You can message a conversation outside this Space only for a member who takes part in it and asked for this Turn`,
      );
    }
  }
}

// Another agent wrote the text, so it is escaped data. The system prompt
// says how to answer it.
function renderTopLevelMessageInput(args: {
  senderConversationId: string;
  text: string;
}): string {
  return renderDataTag(
    "agent-message",
    {
      conversation_id: args.senderConversationId,
      source: "top_level_agent",
    },
    "Another top-level agent",
    args.text.trim(),
  );
}

function topLevelMessageAuthorId(senderConversationId: string): string {
  return `agent-message:${senderConversationId}`;
}

/**
 * Read the steering facts of the Turn that sent a message from another
 * top-level agent. Returns nothing for any other input, also a message from
 * a Turn that acts for no person.
 */
export function readTopLevelMessageSteeringSender(
  message: InboundMessage,
): SteeringSender | undefined {
  const metadata = message.input.metadata;
  return message.source === "event" &&
    isTopLevelAgentMessage(message) &&
    isEventMailboxMetadata(metadata) &&
    message.input.authorId ===
      topLevelMessageAuthorId(metadata.event.identifier)
    ? readSteeringSender(metadata)
    : undefined;
}

/** Whether an input is a message from another top-level agent. */
export function isTopLevelAgentMessage(message: InboundMessage): boolean {
  const metadata = message.input.metadata;
  return (
    isEventMailboxMetadata(metadata) &&
    metadata.event.namespace === AGENT_MESSAGE_EVENT_NAMESPACE &&
    metadata.event.eventType === TOP_LEVEL_AGENT_MESSAGE_EVENT_TYPE
  );
}

/**
 * Send one message from a top-level agent to another top-level agent and
 * wake the target. The access check runs on each call. A stopped target
 * holds the message, so once the automated-turn limit stops one of two
 * agents, they cannot keep each other running. A message from a Turn that
 * acts for a person also carries that Turn's steering facts, so a running
 * Turn of the target for the same Actor and credentials can take it at its
 * next model call. Repeat calls with the same `messageKey` are safe.
 */
export async function enqueueTopLevelAgentMessage(args: {
  /** The person whose input started this Turn, if a person started it. */
  askingActor?: Actor | undefined;
  messageKey: string;
  nowMs?: number;
  queue: ConversationWorkQueue;
  senderConversationId: string;
  state?: StateAdapter | undefined;
  steeringSender?: SteeringSender | undefined;
  text: string;
  to: string;
}): Promise<void> {
  await requireTopLevelAgentAccess(args);
  const nowMs = args.nowMs ?? Date.now();
  const inboundMessageId = `agent-message:${args.senderConversationId}:${args.messageKey}`;
  const summary = `Top-level agent ${args.senderConversationId} sent a message.`;
  const metadata: EventMailboxMetadata = {
    kind: "event",
    event: {
      eventKey: inboundMessageId,
      eventType: TOP_LEVEL_AGENT_MESSAGE_EVENT_TYPE,
      identifier: args.senderConversationId,
      namespace: AGENT_MESSAGE_EVENT_NAMESPACE,
      trustedSummary: summary,
    },
    // Only a running Turn's steering drain reads it. The queued message
    // still runs as the event system Actor.
    ...(args.steeringSender
      ? { steeringSender: args.steeringSender }
      : undefined),
  };
  await enqueueAutomatedInput({
    message: {
      conversationId: args.to,
      createdAtMs: nowMs,
      delivery: "defer",
      inboundMessageId,
      input: {
        // One author per sender, so messages of one sender share a Turn and
        // never join a Turn of watch Events.
        authorId: topLevelMessageAuthorId(args.senderConversationId),
        authorIdentityId: SYSTEM_IDENTITY_ID,
        metadata,
        text: renderTopLevelMessageInput({
          senderConversationId: args.senderConversationId,
          text: args.text,
        }),
      },
      receivedAtMs: nowMs,
      source: "event",
    },
    queue: args.queue,
    queueDelayMs: EVENT_WAIT_MS,
    state: args.state,
  });
}
