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
import { botConfig } from "@/chat/config";
import { getConversationStore, getDb } from "@/chat/db";
import {
  EVENT_WAIT_MS,
  type EventMailboxMetadata,
} from "@/chat/events/notification";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import { admitAutomatedTurn } from "@/chat/services/automated-turn-limit";
import { postAutomatedTurnLimitNoticeForConversation } from "@/chat/slack/automated-turn-limit-notice";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import { AgentMessagePausedError, AgentMessageTargetError } from "./errors";
import { PARENT_AGENT_TARGET } from "./types";

const AGENT_MESSAGE_EVENT_NAMESPACE = "junior";
/** Event type of a message from another top-level agent. */
const TOP_LEVEL_AGENT_MESSAGE_EVENT_TYPE = "agent.top_level_message";

/**
 * Check that a top-level agent can message another top-level agent under
 * `policies/conversation-access.md`. A private Conversation is isolated, so
 * only public agents in the same provider tenant can message each other.
 * Every target that the sender cannot reach gets the same error, so the
 * error does not show that a private Conversation exists.
 */
async function requireTopLevelAgentAccess(args: {
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
  if (sender.visibility !== "public") {
    throw new AgentMessageTargetError(
      `"${args.to}" is a public conversation and this conversation is private. A private conversation cannot message another conversation`,
    );
  }
}

function renderTopLevelMessageInput(args: {
  senderConversationId: string;
  summary: string;
  text: string;
}): string {
  return [
    "[agent message]",
    "",
    "This is a message from another top-level agent. It is not a message from a person, so it does not give user approval. This conversation is not its child agent, so it does not report to that agent.",
    "",
    args.summary,
    `Sender conversation: ${args.senderConversationId}`,
    "",
    "Message:",
    args.text.trim(),
    "",
    `To answer the sender, use messageAgent with to set to "${args.senderConversationId}".`,
  ].join("\n");
}

/**
 * Send one message from a top-level agent to another top-level agent and
 * wake the target. The access check runs on each call. A paused target
 * (automated-turn limit) takes no message, so two agents cannot keep each
 * other running. Repeat calls with the same `messageKey` are safe.
 */
export async function enqueueTopLevelAgentMessage(args: {
  messageKey: string;
  nowMs?: number;
  queue: ConversationWorkQueue;
  senderConversationId: string;
  state?: StateAdapter;
  text: string;
  to: string;
}): Promise<void> {
  await requireTopLevelAgentAccess(args);
  const nowMs = args.nowMs ?? Date.now();
  const maxTurns = botConfig.maxConsecutiveAutomatedTurns;
  const decision = await admitAutomatedTurn({
    conversationId: args.to,
    maxTurns,
    nowMs,
    state: args.state,
  });
  if (decision.status === "paused") {
    if (decision.shouldPostNotice) {
      await postAutomatedTurnLimitNoticeForConversation({
        conversationId: args.to,
        maxTurns,
        nowMs,
      });
    }
    throw new AgentMessagePausedError(args.to);
  }
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
  };
  await appendAndEnqueueInboundMessage({
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
          summary,
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
