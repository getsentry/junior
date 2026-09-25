import type { JuniorSqlDatabase } from "@/db/db";

/** Serialize event sequence allocation with other conversation writes. */
export async function withConversationEventLock<T>(
  executor: JuniorSqlDatabase,
  conversationId: string,
  callback: () => Promise<T>,
): Promise<T> {
  return executor.withLock(`junior_conversation:${conversationId}`, callback);
}
