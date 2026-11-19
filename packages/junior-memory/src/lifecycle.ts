/**
 * Automatic retirement of stale memories.
 *
 * After a Turn, passive extraction can report that the Turn's cited evidence
 * contradicts a recalled memory, or a new memory can say that an older fact
 * changed. Both soft-archive the old memory with a reason, so a person can
 * restore it. Callers own the evidence gate; this module owns the write.
 */
import { and, eq, gt, inArray, isNull, or, type SQL } from "drizzle-orm";
import { juniorMemoryEmbeddings, juniorMemoryMemories } from "./db/schema";
import { publicMemoryScope } from "./scope";
import type { MemoryDb } from "./store";

/** Archive reasons that automatic retirement writes. */
export const RETIRE_REASONS = ["contradicted", "superseded"] as const;
export type RetireReason = (typeof RETIRE_REASONS)[number];

type MemoryRow = typeof juniorMemoryMemories.$inferSelect;
type MemoryTx = Parameters<Parameters<MemoryDb["transaction"]>[0]>[0];

function activePublicPredicate(nowMs: number): SQL[] {
  return [
    eq(juniorMemoryMemories.scope, publicMemoryScope.scope),
    eq(juniorMemoryMemories.scopeKey, publicMemoryScope.scopeKey),
    isNull(juniorMemoryMemories.archivedAtMs),
    isNull(juniorMemoryMemories.supersededAtMs),
    isNull(juniorMemoryMemories.supersededById),
    or(
      isNull(juniorMemoryMemories.expiresAtMs),
      gt(juniorMemoryMemories.expiresAtMs, nowMs),
    )!,
  ];
}

/** Read the active public memories in `ids`, in the order of `ids`. */
export async function loadActiveMemoryRows(
  db: MemoryDb,
  ids: readonly string[],
  nowMs: number,
): Promise<MemoryRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(juniorMemoryMemories)
    .where(
      and(
        ...activePublicPredicate(nowMs),
        inArray(juniorMemoryMemories.id, [...ids]),
      ),
    );
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = rowsById.get(id);
    return row ? [row] : [];
  });
}

/**
 * Soft-archive active public memories with an automatic reason, and drop
 * their vectors. A memory that is no longer active is left as it is.
 */
export async function retireMemoryRows(
  db: MemoryDb | MemoryTx,
  args: {
    filters?: SQL[];
    ids: readonly string[];
    nowMs: number;
    reason: RetireReason;
    supersededById?: string | undefined;
  },
): Promise<MemoryRow[]> {
  if (args.ids.length === 0) return [];
  const retired = await db
    .update(juniorMemoryMemories)
    .set({
      archivedAtMs: args.nowMs,
      archiveReason: args.reason,
      // supersededAtMs stays empty: with it, an archived row would read as
      // an idempotency alias. An active row has no supersededById yet.
      supersededById: args.supersededById ?? null,
    })
    .where(
      and(
        ...activePublicPredicate(args.nowMs),
        ...(args.filters ?? []),
        inArray(juniorMemoryMemories.id, [...args.ids]),
      ),
    )
    .returning();
  if (retired.length > 0) {
    await db.delete(juniorMemoryEmbeddings).where(
      inArray(
        juniorMemoryEmbeddings.memoryId,
        retired.map((row) => row.id),
      ),
    );
  }
  return retired;
}
