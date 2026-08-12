import type { JuniorSqlDatabase } from "@/db/db";

/** Serialize all event sequence allocation and visible projection writes. */
export async function withConversationEventLock<T>(
  executor: JuniorSqlDatabase,
  conversationId: string,
  callback: () => Promise<T>,
): Promise<T> {
  // Event writes and metadata writes touch the same conversation and identity
  // rows. Use the mutation lock so their transactions cannot deadlock by
  // acquiring those rows in different orders.
  return executor.withLock(`junior_conversation:${conversationId}`, callback);
}
