import { sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";

/**
 * Establish the conversation metadata row on first contact for content writes
 * (agent steps, visible transcript) that can land before activity recording has
 * created the row, and whose tables FK to it.
 *
 * First contact creates the row; every later content write advances the
 * activity clock so retention mirrors append-refresh semantics (each content
 * append refreshes the retention window). The timestamp is content-intrinsic
 * (the first item's `createdAtMs`), and `greatest(...)` guarantees a backfilled
 * or imported historical write — which carries an old timestamp — can never
 * regress `last_activity_at`.
 */
export async function ensureConversationRow(
  executor: JuniorSqlDatabase,
  conversationId: string,
  atMs: number,
): Promise<void> {
  const at = new Date(atMs);
  await executor
    .db()
    .insert(juniorConversations)
    .values({
      conversationId,
      createdAt: at,
      lastActivityAt: at,
      updatedAt: at,
      executionStatus: "idle",
    })
    .onConflictDoUpdate({
      target: juniorConversations.conversationId,
      set: {
        lastActivityAt: sql`greatest(${juniorConversations.lastActivityAt}, excluded.last_activity_at)`,
        updatedAt: sql`greatest(${juniorConversations.updatedAt}, excluded.updated_at)`,
        transcriptPurgedAt: null,
      },
    });
}
