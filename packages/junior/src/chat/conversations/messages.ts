/**
 * Conversation-message persistence and hydration.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getConversationEventStore } from "@/chat/db";
import { scheduleConversationTitle } from "@/chat/services/conversation-title";
import { projectConversationMessageSummaries } from "./message-summaries";
import { projectConversationMessages } from "./message-projection";
import type {
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";
import type { ConversationEventStore } from "./history";

/** Author role of a visible conversation message. */
export type ConversationMessageRole = "user" | "assistant" | "system";

/** A source message to record; identity is `(conversationId, messageId)`. */
export interface NewConversationMessage {
  messageId: string;
  role: ConversationMessageRole;
  text: string;
  authorIdentityId?: string;
  meta?: Record<string, unknown>;
  createdAtMs: number;
}

/** Serialize one in-memory message into its event-backed write shape. */
export function toStoredConversationMessage(
  message: ConversationMessage,
): NewConversationMessage {
  const meta: Record<string, unknown> = {};
  if (message.author) meta.author = message.author;
  const { replied, ...restMeta } = message.meta ?? {};
  Object.assign(meta, restMeta);
  if (replied === false) meta.replied = false;
  return {
    messageId: message.id,
    role: message.role,
    text: message.text,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
    createdAtMs: message.createdAtMs,
  };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  );
}

function messageStateKey(message: NewConversationMessage): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(message)))
    .digest("hex")
    .slice(0, 32);
}

/** Hydrate the current message working set from canonical conversation events. */
export async function hydrateConversationMessages(args: {
  conversation: ThreadConversationState;
  conversationId: string | undefined;
}): Promise<void> {
  if (!args.conversationId) {
    args.conversation.messages = [];
    return;
  }
  const history = await getConversationEventStore().loadMessageHistory(
    args.conversationId,
  );
  args.conversation.compactions = history.compaction
    ? projectConversationMessageSummaries([history.compaction])
    : [];
  args.conversation.messages = projectConversationMessages(history);
}

/** Append new messages and handled markers idempotently. */
export async function persistConversationMessages(args: {
  conversation: ThreadConversationState;
  conversationId: string | undefined;
  repliedAtMs?: number;
}): Promise<void> {
  if (!args.conversationId || args.conversation.messages.length === 0) return;

  await appendConversationMessages(getConversationEventStore(), {
    ...args,
    conversationId: args.conversationId,
  });
  // Single automatic title path: start once after durable human transcript.
  scheduleConversationTitle({
    conversation: args.conversation,
    conversationId: args.conversationId,
  });
}

/** Append visible message facts through a caller-owned event-store transaction. */
export async function appendConversationMessages(
  eventStore: ConversationEventStore,
  args: {
    conversation: ThreadConversationState;
    conversationId: string;
    repliedAtMs?: number;
  },
): Promise<void> {
  if (args.conversation.messages.length === 0) return;

  const history = await eventStore.loadMessageHistory(args.conversationId);
  const existingMessages = new Map(
    projectConversationMessages(history).map((message) => [
      message.id,
      message,
    ]),
  );
  const handledAtMs = args.repliedAtMs ?? Date.now();
  const events = args.conversation.messages.flatMap((message) => {
    const stored = toStoredConversationMessage(message);
    const existing = existingMessages.get(stored.messageId);
    const changed =
      existing !== undefined &&
      !isDeepStrictEqual(toStoredConversationMessage(existing), stored);
    const messageEvent = existing
      ? changed
        ? [
            {
              idempotencyKey: `message:${stored.messageId}:update:${messageStateKey(stored)}`,
              createdAtMs: handledAtMs,
              data: {
                type: "message_updated" as const,
                messageId: stored.messageId,
                role: stored.role,
                text: stored.text,
                ...(stored.authorIdentityId
                  ? { authorIdentityId: stored.authorIdentityId }
                  : {}),
                ...(stored.meta ? { meta: stored.meta } : {}),
              },
            },
          ]
        : []
      : [
          {
            idempotencyKey: `message:${stored.messageId}`,
            createdAtMs: stored.createdAtMs,
            data: {
              type: "message" as const,
              messageId: stored.messageId,
              role: stored.role,
              text: stored.text,
              ...(stored.authorIdentityId
                ? { authorIdentityId: stored.authorIdentityId }
                : {}),
              ...(stored.meta ? { meta: stored.meta } : {}),
            },
          },
        ];
    return [
      ...messageEvent,
      ...(message.meta?.replied === true
        ? [
            {
              idempotencyKey: `message:${stored.messageId}:handled`,
              createdAtMs: handledAtMs,
              data: {
                type: "message_handled" as const,
                messageId: stored.messageId,
              },
            },
          ]
        : []),
    ];
  });
  await eventStore.append(args.conversationId, events);
}
