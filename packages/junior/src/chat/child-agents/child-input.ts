import { isPersonInput } from "@/chat/conversations/kind-behavior";
import { CORE_EVENT_NAMESPACE } from "@/chat/events/catalog";
import { isEventMailboxMetadata } from "@/chat/events/mailbox-metadata";
import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getSqlExecutor } from "@/chat/db";
import { readInboundMessageSender } from "@/chat/task-execution/message-sender";
import type { ConversationMessageMeta } from "@/chat/state/conversation";
import type { InboundMessage } from "@/chat/task-execution/store";
import { juniorAgentBindings, juniorConversations } from "@/db/schema";
import { hasParentMessageAuthor } from "./parent-message";
import { readParentMessage, type ParentMessage } from "./parent-message-input";
import {
  AGENT_MESSAGE_EVENT_TYPE,
  isAgentUpdateEventType,
} from "./result-event-type";
import type { ChildAgentSender } from "./types";

const parent = alias(juniorConversations, "parent");

/**
 * One reply or message that a child agent sent to its parent. `senderId` is
 * the child Conversation.
 */
type ChildAgentInput = {
  kind: "message" | "reply";
  senderId: string;
};

function childAgentInputKind(
  namespace: string | undefined,
  eventType: string | undefined,
  watchId: string | undefined,
): ChildAgentInput["kind"] | undefined {
  if (namespace !== CORE_EVENT_NAMESPACE || !eventType) {
    return undefined;
  }
  if (eventType === AGENT_MESSAGE_EVENT_TYPE) {
    return "message";
  }
  // A Watch delivers the same agent update from a Conversation that is not
  // a child agent. It names its Watch, and a child's update does not.
  return isAgentUpdateEventType(eventType) && watchId === undefined
    ? "reply"
    : undefined;
}

/** Read the child that one reply or message Event names. */
export function childAgentInput(
  message: InboundMessage,
): ChildAgentInput | undefined {
  const metadata = message.input.metadata;
  if (!isEventMailboxMetadata(metadata)) {
    return undefined;
  }
  const kind = childAgentInputKind(
    metadata.event.namespace,
    metadata.event.eventType,
    metadata.event.subscriptionId,
  );
  return kind ? { kind, senderId: metadata.event.identifier } : undefined;
}

/**
 * Whether one input is the `stopped` result that the stop of its sender
 * sends. Only a stop reports `stopped`, so the stored status tells this
 * result from the reply of a Turn.
 */
export function isStopResult(message: {
  input: { metadata?: Record<string, unknown> | undefined };
}): boolean {
  const metadata = message.input.metadata;
  return (
    isEventMailboxMetadata(metadata) &&
    metadata.event.namespace === CORE_EVENT_NAMESPACE &&
    isAgentUpdateEventType(metadata.event.eventType) &&
    metadata.event.status === "stopped"
  );
}

/**
 * Whether the saved Event fields of a Turn's input Message name a child
 * agent's reply or message. A new and a resumed Turn read the same fields.
 */
export function isChildAgentEvent(
  meta:
    | Pick<
        ConversationMessageMeta,
        "eventNamespace" | "eventType" | "eventWatchId"
      >
    | undefined,
): boolean {
  return Boolean(
    childAgentInputKind(
      meta?.eventNamespace,
      meta?.eventType,
      meta?.eventWatchId,
    ),
  );
}

/**
 * The stored stops that decide which input a Conversation drops. Read them
 * with `readChildInputDropFacts`.
 */
export type ChildInputDropFacts = {
  /**
   * The stop of each child that received a parent message, keyed by its
   * stored parent edge. An edge that is missing is not the stored parent.
   */
  childStops: ReadonlyMap<string, Date | null>;
  /** The stop of each sender of a child reply that is stopped. */
  senderStops: ReadonlyMap<string, Date>;
};

/**
 * Return the stored parent edge that a parent message claims, or undefined
 * when its author id is not that parent's, so it is dropped with no read.
 */
function claimedParentEdge(
  message: InboundMessage,
  parentMessage: ParentMessage,
): string | undefined {
  return hasParentMessageAuthor(message, parentMessage)
    ? parentEdgeKey(message.conversationId, parentMessage.parentConversationId)
    : undefined;
}

function parentEdgeKey(
  childConversationId: string,
  parentConversationId: string,
): string {
  return JSON.stringify([childConversationId, parentConversationId]);
}

/**
 * Return the child that sent a reply that a stop can skip. A message that a
 * child sent is still delivered, and so is the `stopped` result that a
 * person's stop sends.
 */
function skippableReplySender(message: InboundMessage): string | undefined {
  if (childAgentInput(message)?.kind !== "reply" || isStopResult(message)) {
    return undefined;
  }
  return readInboundMessageSender(message)?.conversationId;
}

/**
 * Read the stops that `isDroppedChildInput` needs for many inputs, with one
 * query for the receiving children and one for the reply senders.
 */
export async function readChildInputDropFacts(
  messages: readonly InboundMessage[],
): Promise<ChildInputDropFacts> {
  const childIds = new Set<string>();
  const parentIds = new Set<string>();
  const senderIds = new Set<string>();
  for (const message of messages) {
    const parentMessage = readParentMessage(message);
    if (parentMessage) {
      if (claimedParentEdge(message, parentMessage)) {
        childIds.add(message.conversationId);
        parentIds.add(parentMessage.parentConversationId);
      }
      continue;
    }
    const sender = skippableReplySender(message);
    if (sender) {
      senderIds.add(sender);
    }
  }
  const db = getSqlExecutor().db();
  const [children, senders] = await Promise.all([
    childIds.size > 0
      ? db
          .select({
            conversationId: juniorConversations.conversationId,
            parentConversationId: parent.conversationId,
            stoppedAt: juniorConversations.stoppedAt,
          })
          .from(juniorConversations)
          .innerJoin(
            parent,
            eq(parent.conversationId, juniorConversations.parentConversationId),
          )
          .where(
            and(
              inArray(juniorConversations.conversationId, [...childIds]),
              inArray(parent.conversationId, [...parentIds]),
            ),
          )
      : [],
    senderIds.size > 0
      ? db
          .select({
            conversationId: juniorConversations.conversationId,
            stoppedAt: juniorConversations.stoppedAt,
          })
          .from(juniorConversations)
          .where(inArray(juniorConversations.conversationId, [...senderIds]))
      : [],
  ]);
  return {
    childStops: new Map(
      children.map((row) => [
        parentEdgeKey(row.conversationId, row.parentConversationId),
        row.stoppedAt,
      ]),
    ),
    senderStops: new Map(
      senders.flatMap((row) =>
        row.stoppedAt ? [[row.conversationId, row.stoppedAt]] : [],
      ),
    ),
  };
}

/**
 * Return whether a Conversation drops one input, so it starts no work. Routing
 * and child status both read it, so they agree. `facts` are from
 * `readChildInputDropFacts`. A parent message is dropped when it is not from
 * the stored parent, or was sent before the child's stop. A stop drops unread
 * replies from the parent's mailbox. One sent before the stop can reach the
 * mailbox after that drop, so while the sending child is stopped, a reply that
 * it sent after the stop is dropped too. A stopped Conversation never reads
 * other automated input: `enqueueAutomatedInput` and the stop hold it first.
 */
export function isDroppedChildInput(
  message: InboundMessage,
  facts: ChildInputDropFacts,
): boolean {
  if (isPersonInput(message.source)) {
    return false;
  }
  const parentMessage = readParentMessage(message);
  if (parentMessage) {
    const edge = claimedParentEdge(message, parentMessage);
    if (!edge || !facts.childStops.has(edge)) {
      return true;
    }
    const stoppedAtMs = facts.childStops.get(edge)?.getTime();
    return stoppedAtMs !== undefined && message.receivedAtMs <= stoppedAtMs;
  }
  const sender = skippableReplySender(message);
  const senderStoppedAtMs = sender
    ? facts.senderStops.get(sender)?.getTime()
    : undefined;
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
  const [row] = await getSqlExecutor()
    .db()
    .select({
      agentName: juniorAgentBindings.name,
      parentConversationId: parent.conversationId,
      parentKind: parent.kind,
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
        ...(row.parentKind ? { parentKind: row.parentKind } : undefined),
        ...(row.title ? { title: row.title } : undefined),
      }
    : undefined;
}

/**
 * Read the sender of one reply or message, when it is a child of the
 * Conversation that received it. Input that names no child of this
 * Conversation has no sender, so `withSenderActors` runs it as the Event
 * system Actor and it gets no child's authority.
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
