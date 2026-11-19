/**
 * Automatic retirement of stale memories.
 *
 * After a Turn, passive extraction can report that the Turn's cited evidence
 * contradicts a recalled memory, or a new memory can say that an older fact
 * changed. Both soft-archive the old memory with a reason, so a person can
 * restore it. Callers own the evidence gate; this module owns the write.
 */
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
} from "drizzle-orm";
import {
  juniorMemoryEmbeddings,
  juniorMemoryMemories,
  juniorMemorySignals,
} from "./db/schema";
import { publicMemoryScope, type ResolvedMemoryScope } from "./scope";
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
 * Find the archived memory that holds a write key. A retried write with that
 * key must not bring back a memory that a person or a Turn retired. An
 * expired memory is not retired: a retry may write it again.
 */
export async function findArchivedWriteKeyMemory(
  db: MemoryDb,
  args: { idempotencyKey: string; scope: ResolvedMemoryScope },
): Promise<MemoryRow | undefined> {
  const [row] = await db
    .select()
    .from(juniorMemoryMemories)
    .where(
      and(
        eq(juniorMemoryMemories.scope, args.scope.scope),
        eq(juniorMemoryMemories.scopeKey, args.scope.scopeKey),
        eq(juniorMemoryMemories.idempotencyKey, args.idempotencyKey),
        isNotNull(juniorMemoryMemories.archivedAtMs),
        ne(juniorMemoryMemories.archiveReason, "expired"),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Soft-archive active public memories with an automatic reason, drop their
 * vectors, and record one signal per memory with the evidence Conversation.
 * A memory that is no longer active is left as it is.
 */
export async function retireMemoryRows(
  db: MemoryDb | MemoryTx,
  args: {
    /** Write key of the Turn or memory that retired the rows. */
    auditKey: string;
    conversationId: string | undefined;
    filters?: SQL[];
    ids: readonly string[];
    nowMs: number;
    reason: RetireReason;
    supersededById?: string | undefined;
  },
): Promise<MemoryRow[]> {
  if (args.ids.length === 0) return [];
  // Archive and signal commit together, so the audit trail has no gaps. In a
  // caller's transaction this is a savepoint.
  return await db.transaction(async (tx) => {
    const retired = await tx
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
      await tx.delete(juniorMemoryEmbeddings).where(
        inArray(
          juniorMemoryEmbeddings.memoryId,
          retired.map((row) => row.id),
        ),
      );
      await tx
        .insert(juniorMemorySignals)
        .values(
          retired.map((row) => ({
            conversationId: args.conversationId ?? null,
            idempotencyKey: args.auditKey,
            memoryId: row.id,
            observedAtMs: args.nowMs,
            signal: args.reason,
          })),
        )
        .onConflictDoNothing();
    }
    return retired;
  });
}
