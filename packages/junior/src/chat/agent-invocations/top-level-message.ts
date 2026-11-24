/**
 * Agent messages between top-level agents: root Conversations that are not
 * in the same agent tree. A message wakes the target like any other Event.
 * The target runs it as the event system Actor, so the sender's Actor and
 * credentials never reach the target.
 */
import type { StateAdapter } from "chat";
import {
  canAccessConversation,
  readConversationAccessFromSql,
} from "@/api/conversations/access";
import { getConversationStore, getDb } from "@/chat/db";
import {
  EVENT_WAIT_MS,
  type EventMailboxMetadata,
} from "@/chat/events/notification";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import { renderDataTag } from "@/chat/input-tags";
import { isLeadToRoot } from "@/chat/lead/conversation";
import { isLeadTeamRoot } from "./team";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  enqueueAutomatedInput,
  resumeConversationTree,
} from "@/chat/conversations/session-stop";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { AgentMessageTargetError } from "./errors";
import { PARENT_AGENT_TARGET } from "./types";

const AGENT_MESSAGE_EVENT_NAMESPACE = "junior";
/** Event type of a message from another top-level agent. */
export const TOP_LEVEL_AGENT_MESSAGE_EVENT_TYPE = "agent.top_level_message";

/**
 * Check that a top-level agent can message another top-level agent under
 * `policies/conversation-access.md`. Public agents can message each other.
 * A private agent can message only agents at its own Destination, such as
 * another thread in the same private Slack channel. A Lead can also message
 * any public root, as its person could.
 * Every target that the sender cannot reach gets the same error, so the
 * error does not show that a private Conversation exists.
 */
async function requireTopLevelAgentAccess(args: {
  senderConversationId: string;
  to: string;
}): Promise<{ onLeadTeam: boolean }> {
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
  // enters a public Conversation, except from a Lead into a root: the Lead
  // writes there for its person, as the person could. The target is public,
  // so this error shows nothing private.
  const fromLead = await isLeadToRoot({
    leadConversationId: args.senderConversationId,
    rootConversationId: args.to,
  });
  if (
    receiver.visibility === "public" &&
    sender.visibility !== "public" &&
    !fromLead
  ) {
    throw new AgentMessageTargetError(
      `"${args.to}" is a public conversation and this conversation is private. A private conversation can message only conversations in its own channel or DM`,
    );
  }
  return {
    onLeadTeam:
      fromLead &&
      (await isLeadTeamRoot({
        conversationId: args.to,
        leadConversationId: args.senderConversationId,
      })),
  };
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

/**
 * Send one message from a top-level agent to another top-level agent and
 * wake the target. The access check runs on each call. A stopped target
 * holds the message, so once the automated-turn limit stops one of two
 * agents, they cannot keep each other running. A Lead's message to a root
 * on its team is the exception: it ends the stop. Repeat calls with the
 * same `messageKey` are safe.
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
  const { onLeadTeam } = await requireTopLevelAgentAccess(args);
  const nowMs = args.nowMs ?? Date.now();
  const inboundMessageId = `agent-message:${args.senderConversationId}:${args.messageKey}`;
  if (onLeadTeam) {
    await endStopForLeadMessage({
      conversationId: args.to,
      inboundMessageId,
      sentAtMs: nowMs,
      state: args.state,
    });
  }
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

// A Lead's message is new work for a root on its team, as a parent's
// message is for a child, so it ends the root's stop. A replay is not new
// work: the mailbox keeps the id, even of held input.
async function endStopForLeadMessage(args: {
  conversationId: string;
  inboundMessageId: string;
  sentAtMs: number;
  state?: StateAdapter | undefined;
}): Promise<void> {
  const work = await getConversationWorkState({
    conversationId: args.conversationId,
    state: args.state,
  });
  if (work?.execution.inboundMessageIds.includes(args.inboundMessageId)) {
    return;
  }
  await resumeConversationTree(args.conversationId, args.sentAtMs);
}
