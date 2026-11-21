/**
 * Restore archived memories.
 *
 * Archive is soft, so a person can undo a forget or an automatic retirement.
 * Restore makes the row active again. Archive deleted its vectors; the
 * re-embed heartbeat writes them again, and until then recall finds the
 * memory by full-text search.
 */
import { and, asc, eq, isNull, like, or } from "drizzle-orm";
import { juniorMemoryMemories } from "@/db/schema/memory";
import { parseMemoryRow, type MemoryDb, type MemoryRecord } from "./store";
import { archivedMemoryPredicate, MemoryNotFoundError } from "./viewer";

/** Expected error when an active memory already holds the write key. */
export class MemoryRestoreConflictError extends Error {
  constructor() {
    super("An active memory already replaces this memory.");
    this.name = "MemoryRestoreConflictError";
  }
}

/**
 * Make one archived public memory active again. `id` is a full id or an
 * unambiguous id prefix.
 */
export async function restoreMemory(
  db: MemoryDb,
  input: { id: string; nowMs: number },
): Promise<MemoryRecord> {
  const idPrefix = input.id.trim();
  if (!idPrefix) throw new Error("Memory id is required.");
  return await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(juniorMemoryMemories)
      .where(
        and(
          archivedMemoryPredicate(input.nowMs),
          or(
            eq(juniorMemoryMemories.id, idPrefix),
            like(juniorMemoryMemories.id, `${idPrefix}%`),
          ),
        ),
      )
      .orderBy(asc(juniorMemoryMemories.id))
      .limit(2)
      .for("update");
    const exact = rows.find((row) => row.id === idPrefix);
    if (rows.length > 1 && !exact) {
      throw new Error("Memory id prefix is ambiguous.");
    }
    const row = exact ?? rows[0];
    if (!row) throw new MemoryNotFoundError();
    if (row.idempotencyKey) {
      // The active idempotency index allows one active row per key.
      const [holder] = await tx
        .select({ id: juniorMemoryMemories.id })
        .from(juniorMemoryMemories)
        .where(
          and(
            eq(juniorMemoryMemories.scope, row.scope),
            eq(juniorMemoryMemories.scopeKey, row.scopeKey),
            eq(juniorMemoryMemories.idempotencyKey, row.idempotencyKey),
            isNull(juniorMemoryMemories.archivedAtMs),
            isNull(juniorMemoryMemories.supersededAtMs),
            isNull(juniorMemoryMemories.supersededById),
          ),
        )
        .limit(1);
      if (holder) throw new MemoryRestoreConflictError();
    }
    const [restored] = await tx
      .update(juniorMemoryMemories)
      .set({ archivedAtMs: null, archiveReason: null, supersededById: null })
      .where(eq(juniorMemoryMemories.id, row.id))
      .returning();
    return parseMemoryRow(restored);
  });
}
