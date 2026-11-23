/**
 * Agent messages between top-level agents: root Conversations that are not
 * in the same agent tree. A message wakes the target like any other Event.
 * The target runs it as the event system Actor, so the sender's Actor and
 * credentials never reach the target. The one exception is a Lead's message
 * into a root where its person is a Participant: it passes on the person's
 * instruction, so it runs as the person, the same as the task of
 * `startConversation`.
 */
import type { StateAdapter } from "chat";
import {
  escapeClosingTags,
  renderTag,
  type Actor,
} from "@sentry/junior-plugin-api";
import {
  canAccessConversation,
  readConversationAccessFromSql,
} from "@/api/conversations/access";
import { webActorFromUser } from "@/chat/conversations/web-input";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import {
  EVENT_WAIT_MS,
  type EventMailboxMetadata,
} from "@/chat/events/notification";
import {
  resolveActorIdentityId,
  SYSTEM_IDENTITY_ID,
} from "@/chat/identities/actor";
import { renderUntrustedTag } from "@/chat/input-tags";
import { leadPersonParticipates, readLeadUser } from "@/chat/lead/conversation";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { enqueueAutomatedInput } from "@/chat/conversations/session-stop";
import { AgentMessageTargetError } from "./errors";
import { TOP_LEVEL_AGENT_MESSAGE_EVENT_TYPE } from "./result-event-type";
import { PARENT_AGENT_TARGET } from "./types";

const AGENT_MESSAGE_EVENT_NAMESPACE = "junior";

/**
 * Check that a top-level agent can message another top-level agent under
 * `policies/conversation-access.md`. Public agents can message each other.
 * A private agent can message only agents at its own Destination, such as
 * another thread in the same private Slack channel. A Lead can also message
 * a public root where its person is a Participant, so it can steer the
 * person's work.
 * Every target that the sender cannot reach gets the same error, so the
 * error does not show that a private Conversation exists. Returns true when
 * the sender is a Lead that writes into a root of its person.
 */
async function requireTopLevelAgentAccess(args: {
  senderConversationId: string;
  to: string;
}): Promise<boolean> {
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
  // enters a public Conversation, except from a Lead into a root where its
  // person takes part: the Lead writes there for that person. The target is
  // public, so this error shows nothing private.
  if (receiver.visibility !== "public" || sender.visibility === "public") {
    return false;
  }
  if (
    !(await leadPersonParticipates({
      leadConversationId: args.senderConversationId,
      rootConversationId: args.to,
    }))
  ) {
    throw new AgentMessageTargetError(
      `"${args.to}" is a public conversation and this conversation is private. A private conversation can message only conversations in its own channel or DM`,
    );
  }
  return true;
}

// The web Actor of a Lead's person and its Identity: the same Actor that
// `startConversation` gives the root that it starts.
async function readLeadPerson(
  leadConversationId: string,
): Promise<{ actor: Actor; identityId: string }> {
  const user = await readLeadUser(leadConversationId);
  if (!user) throw new Error("Only a Lead writes into a root of its person");
  const actor = webActorFromUser(user);
  const identityId = await resolveActorIdentityId(getSqlExecutor(), actor);
  if (!identityId) throw new Error("A Lead needs a web Identity");
  return { actor, identityId };
}

// Another agent wrote the text, so it is escaped data. The system prompt
// says how to answer it.
function renderTopLevelMessageInput(args: {
  senderConversationId: string;
  text: string;
}): string {
  return renderUntrustedTag(
    "agent-message",
    {
      conversation_id: args.senderConversationId,
      source: "top_level_agent",
    },
    "Another top-level agent",
    args.text.trim(),
  );
}

// A Lead passes on its person's instruction, so the text is not escaped as
// data. Only a copy of the closing tag is escaped.
function renderLeadMessageInput(args: {
  senderConversationId: string;
  text: string;
}): string {
  return renderTag("lead-message", {}, [
    "The Lead of the person you work for passes on their instruction.",
    `conversation_id: ${args.senderConversationId}`,
    escapeClosingTags(args.text.trim()),
  ]);
}

/**
 * Send one message from a top-level agent to another top-level agent and
 * wake the target. The access check runs on each call. A stopped target
 * holds the message, so once the automated-turn limit stops one of two
 * agents, they cannot keep each other running. Repeat calls with the same
 * `messageKey` are safe.
 */
export async function enqueueTopLevelAgentMessage(args: {
  messageKey: string;
  nowMs?: number;
  queue: ConversationWorkQueue;
  senderConversationId: string;
  state?: StateAdapter | undefined;
  text: string;
  to: string;
}): Promise<void> {
  const fromLead = await requireTopLevelAgentAccess(args);
  const person = fromLead
    ? await readLeadPerson(args.senderConversationId)
    : undefined;
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
    // `withAgentInvocationResultActors` runs the message as this Actor.
    ...(person ? { actor: person.actor } : undefined),
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
        authorId: `agent-message:${args.senderConversationId}`,
        authorIdentityId: person?.identityId ?? SYSTEM_IDENTITY_ID,
        metadata,
        text: (person ? renderLeadMessageInput : renderTopLevelMessageInput)({
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
