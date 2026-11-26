// Core's writes to the Conversation history: agent history items, stored with
// no host side effect. The host's ingress creates the Conversation row before
// it schedules an input, and every event row references that row.
import type { AgentHistoryItem } from "./items";
import { encodeAgentHistoryPayload } from "./rows";
import {
  insertEventRows,
  readEventCursor,
  unseenEvents,
} from "@/conversation-events/store";
import type { JuniorSqlDatabase } from "@/db/db";

/** One agent history item to store, with its idempotency key and time. */
export type NewAgentHistoryItem = {
  item: AgentHistoryItem;
  idempotencyKey: string;
  createdAtMs: number;
};

/**
 * Appends agent history items in order, at the current History version.
 * Skips an item whose idempotency key is already stored. Call it under
 * `withConversationEventLock`.
 */
export async function appendAgentHistory(
  executor: JuniorSqlDatabase,
  conversationId: string,
  items: readonly NewAgentHistoryItem[],
): Promise<void> {
  const pending = await unseenEvents(executor, conversationId, items);
  if (pending.length === 0) return;
  await insertEventRows(
    executor,
    conversationId,
    await readEventCursor(executor, conversationId),
    pending.map(({ item, idempotencyKey, createdAtMs }) => ({
      type: item.type,
      ...encodeAgentHistoryPayload(item),
      idempotencyKey,
      createdAtMs,
    })),
  );
}
