import type { JuniorSqlDatabase } from "@/db/db";

/** Serialize all event sequence allocation and visible projection writes. */
export async function withConversationEventLock<T>(
  executor: JuniorSqlDatabase,
  conversationId: string,
  callback: () => Promise<T>,
): Promise<T> {
  return executor.withLock(
    `junior_conversation:event:${conversationId}`,
    callback,
  );
}
