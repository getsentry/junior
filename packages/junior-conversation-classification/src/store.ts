/** Plugin-owned SQL persistence for idempotent per-turn classifications. */
import { eq, lte } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import * as schema from "./db/schema";
import { juniorConversationClassifications } from "./db/schema";

export type ConversationClassificationDb = PgDatabase<
  PgQueryResultHKT,
  typeof schema
>;

export type ConversationClassificationRecord =
  typeof juniorConversationClassifications.$inferSelect;

/** Read one classification by its durable plugin task id. */
export async function getConversationClassification(
  db: ConversationClassificationDb,
  taskId: string,
): Promise<ConversationClassificationRecord | undefined> {
  const [record] = await db
    .select()
    .from(juniorConversationClassifications)
    .where(eq(juniorConversationClassifications.taskId, taskId))
    .limit(1);
  return record;
}

/** Insert one completed-turn classification idempotently. */
export async function insertConversationClassification(
  db: ConversationClassificationDb,
  record: ConversationClassificationRecord,
): Promise<ConversationClassificationRecord> {
  const [inserted] = await db
    .insert(juniorConversationClassifications)
    .values(record)
    .onConflictDoNothing({ target: juniorConversationClassifications.taskId })
    .returning();
  if (inserted) {
    return inserted;
  }
  const existing = await getConversationClassification(db, record.taskId);
  if (!existing) {
    throw new Error("Conversation classification insert returned no record");
  }
  return existing;
}

/** Delete classifications after the plugin-owned retention window. */
export async function deleteExpiredConversationClassifications(
  db: ConversationClassificationDb,
  nowMs: number,
): Promise<number> {
  const deleted = await db
    .delete(juniorConversationClassifications)
    .where(lte(juniorConversationClassifications.expiresAtMs, nowMs))
    .returning({ taskId: juniorConversationClassifications.taskId });
  return deleted.length;
}
