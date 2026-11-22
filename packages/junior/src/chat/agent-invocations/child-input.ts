import { isPersonInput } from "@/chat/conversations/kind-behavior";
import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import { isEventMailboxMetadata } from "@/chat/events/notification";
import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getSqlExecutor } from "@/chat/db";
import { readInboundMessageSender } from "@/chat/task-execution/message-sender";
import type { InboundMessage } from "@/chat/task-execution/store";
import { juniorAgentBindings, juniorConversations } from "@/db/schema";
import { isPersonStopTurnId } from "./ids";
import { isFromStoredParent } from "./parent-message";
import { readParentMessage } from "./parent-message-input";
import {
  AGENT_INVOCATION_EVENT_NAMESPACE,
  AGENT_MESSAGE_EVENT_TYPE,
  AGENT_REPLY_EVENT_TYPE,
} from "./result-event-type";
import type { ChildAgentSender } from "./types";

/**
 * One reply or message that a child agent sent to its parent. `senderId` is
 * the child Conversation.
 */
export type ChildAgentInput = {
  kind: "message" | "reply";
  senderId: string;
};

/** Read the child that one reply or message Event names. */
export function childAgentInput(
  message: InboundMessage,
): ChildAgentInput | undefined {
  const metadata = message.input.metadata;
  if (
    !isEventMailboxMetadata(metadata) ||
    metadata.event.namespace !== AGENT_INVOCATION_EVENT_NAMESPACE
  ) {
    return undefined;
  }
  switch (metadata.event.eventType) {
    case AGENT_MESSAGE_EVENT_TYPE:
      return { kind: "message", senderId: metadata.event.identifier };
    case AGENT_REPLY_EVENT_TYPE:
      return { kind: "reply", senderId: metadata.event.identifier };
    default:
      return undefined;
  }
}

/**
 * Return whether a Conversation drops one input, so it starts no work.
 * Routing, the stop skips, and the child agent status all read this, so they
 * agree on which input starts work.
 *
 * A parent message is dropped when it does not come from the stored parent,
 * or when it was sent before the child's stop. A child reply that a stop
 * skips is dropped too. A stopped Conversation never reads other automated
 * input: `enqueueAutomatedInput` and the stop hold it first.
 */
export async function isDroppedChildInput(
  message: InboundMessage,
): Promise<boolean> {
  if (isPersonInput(message.source)) {
    return false;
  }
  const parentMessage = readParentMessage(message);
  if (parentMessage) {
    if (!(await isFromStoredParent(message, parentMessage))) {
      return true;
    }
    const stoppedAtMs = await getConversationStoppedAtMs(
      message.conversationId,
    );
    return stoppedAtMs !== undefined && message.receivedAtMs <= stoppedAtMs;
  }
  const input = childAgentInput(message);
  return input?.kind === "reply" && (await isSkippedReply(message));
}

/**
 * Return whether a stop skipped this reply. A stop drops a child's unread
 * replies from the parent's mailbox. One sent before the stop can reach the
 * mailbox after that drop, so while the sending child is stopped, a reply
 * that it sent after the stop is dropped too, except the `stopped` result
 * that a person's stop sends. A message that a child sent is still
 * delivered.
 */
async function isSkippedReply(message: InboundMessage): Promise<boolean> {
  const sender = readInboundMessageSender(message);
  if (!sender || isPersonStopTurnId(sender.turnId)) {
    return false;
  }
  const senderStoppedAtMs = await getConversationStoppedAtMs(
    sender.conversationId,
  );
  return (
    senderStoppedAtMs !== undefined && message.createdAtMs >= senderStoppedAtMs
  );
}

/**
 * Read the sender of one child Conversation from its parent edge and its
 * binding. A Conversation without a parent has none.
 */
export async function readChildConversationSender(
  childConversationId: string,
): Promise<ChildAgentSender | undefined> {
  const parent = alias(juniorConversations, "parent");
  const [row] = await getSqlExecutor()
    .db()
    .select({
      agentName: juniorAgentBindings.name,
      parentConversationId: parent.conversationId,
      title: juniorConversations.title,
    })
    .from(juniorConversations)
    .innerJoin(
      parent,
      eq(parent.conversationId, juniorConversations.parentConversationId),
    )
    .leftJoin(
      juniorAgentBindings,
      eq(
        juniorAgentBindings.childConversationId,
        juniorConversations.conversationId,
      ),
    )
    .where(eq(juniorConversations.conversationId, childConversationId));
  return row
    ? {
        ...(row.agentName ? { agentName: row.agentName } : undefined),
        childConversationId,
        parentConversationId: row.parentConversationId,
        ...(row.title ? { title: row.title } : undefined),
      }
    : undefined;
}

/**
 * Read the sender of one reply or message, when it is a child of the
 * Conversation that received it. Otherwise the input has no child sender,
 * such as one that an Agent invocation of an earlier release sent.
 */
export async function getChildAgentInputSender(
  message: InboundMessage,
  input: ChildAgentInput,
): Promise<ChildAgentSender | undefined> {
  const sender = await readChildConversationSender(input.senderId);
  return sender?.parentConversationId === message.conversationId
    ? sender
    : undefined;
}
