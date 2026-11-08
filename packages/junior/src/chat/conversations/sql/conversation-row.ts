import { sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import type { ConversationKind } from "@/chat/conversations/store";
import { juniorConversations } from "@/db/schema";
import { nextDetailVersion } from "./detail-version";

/**
 * Establish the conversation metadata row on first contact for content writes
 * (conversation events, visible transcript) that can land before activity has
 * created the row, and whose tables FK to it.
 *
 * First contact creates the row; every later content write advances the
 * activity clock so retention mirrors append-refresh semantics (each content
 * append refreshes the retention window). Background observations may opt out
 * and leave an existing row unchanged. The timestamp is content-intrinsic (the
 * first item's `createdAtMs`), and `greatest(...)` guarantees a backfilled or
 * imported historical write — which carries an old timestamp — can never
 * regress `last_activity_at`.
 */
export async function ensureConversationRow(
  executor: JuniorSqlDatabase,
  conversationId: string,
  atMs: number,
  options: { activity?: "preserve" } = {},
): Promise<void> {
  const at = new Date(atMs);
  const insert = executor.db().insert(juniorConversations).values({
    conversationId,
    createdAt: at,
    lastActivityAt: at,
    updatedAt: at,
    executionStatus: "idle",
    // A first-contact row has no parent, and a parent cannot be added later.
    kind: "root",
  });
  if (options.activity === "preserve") {
    await insert.onConflictDoNothing({
      target: juniorConversations.conversationId,
    });
    return;
  }
  await insert.onConflictDoUpdate({
    target: juniorConversations.conversationId,
    set: {
      lastActivityAt: sql`greatest(${juniorConversations.lastActivityAt}, excluded.last_activity_at)`,
      updatedAt: sql`greatest(${juniorConversations.updatedAt}, excluded.updated_at)`,
      transcriptPurgedAt: null,
      detailVersion: nextDetailVersion,
    },
  });
}

/** Decode a stored kind. A null kind comes from a writer of an older deploy. */
export function conversationKindFromRow(row: {
  kind: ConversationKind | null;
  parentConversationId: string | null;
}): ConversationKind {
  // TODO(dcramer): Read `kind` as stored after the NOT NULL contract.
  const kind = row.kind ?? (row.parentConversationId ? "task" : "root");
  if (kind !== "root" && kind !== "thread" && kind !== "task") {
    throw new Error("Conversation record kind is invalid");
  }
  return kind;
}
