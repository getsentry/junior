import type { StateAdapter } from "chat";
import type { Actor } from "@/chat/actor";
import { EVENT_WAIT_MS } from "@/chat/events/notification";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import { renderUntrustedTag } from "@/chat/input-tags";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import { childAgentLabel, resultAuthorId, senderEventMetadata } from "./result";
import {
  AGENT_INVOCATION_EVENT_NAMESPACE,
  AGENT_MESSAGE_EVENT_TYPE,
} from "./result-event-type";
import type { ChildAgentSender } from "./types";

function renderMessageInput(sender: ChildAgentSender, text: string): string {
  return renderUntrustedTag(
    "agent-message",
    {
      conversation_id: sender.childConversationId,
      name: sender.agentName,
      source: "child_agent",
      title: sender.title,
    },
    "A child agent that you started",
    text.trim(),
  );
}

/**
 * Return the parent mailbox id of one Agent message. `messageKey` is empty
 * for the prefix that every Agent message of `senderId` shares.
 */
export function agentMessageInboundId(
  senderId: string,
  messageKey: string,
): string {
  return `agent-invocation:${senderId}:message:${messageKey}`;
}

/**
 * Append one message from a child agent to its parent mailbox and wake the
 * parent. `sender` names the child, and `actor` is the Actor of the child's
 * Turn. The parent handles the message like a result. Repeat calls with the
 * same `messageKey` are safe.
 */
export async function enqueueAgentMessageToParent(args: {
  actor: Actor;
  messageKey: string;
  nowMs?: number;
  queue: ConversationWorkQueue;
  sender: ChildAgentSender;
  state?: StateAdapter | undefined;
  text: string;
}): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  const senderId = args.sender.invocationId ?? args.sender.childConversationId;
  const inboundMessageId = agentMessageInboundId(senderId, args.messageKey);
  const summary = `${childAgentLabel(args.sender)} sent a message.`;
  const metadata = senderEventMetadata(args.sender, args.actor, {
    eventKey: inboundMessageId,
    eventType: AGENT_MESSAGE_EVENT_TYPE,
    identifier: senderId,
    namespace: AGENT_INVOCATION_EVENT_NAMESPACE,
    trustedSummary: summary,
  });
  await appendAndEnqueueInboundMessage({
    message: {
      conversationId: args.sender.parentConversationId,
      createdAtMs: nowMs,
      delivery: "defer",
      inboundMessageId,
      input: {
        authorId: resultAuthorId(args.actor),
        authorIdentityId: SYSTEM_IDENTITY_ID,
        metadata,
        text: renderMessageInput(args.sender, args.text),
      },
      receivedAtMs: nowMs,
      source: "event",
    },
    queue: args.queue,
    queueDelayMs: EVENT_WAIT_MS,
    state: args.state,
  });
}
