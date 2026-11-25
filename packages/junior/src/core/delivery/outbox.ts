// The outbox rows of a Turn: one row per reply that Delivery must send. The
// commit that writes a step's replies writes their rows too, so a reply is
// never in history without a row that a delivery message or the sweep finds.
import { randomUUID } from "node:crypto";
import { and, eq, lt, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { EngineContext } from "@/core/engine-context";
import { findTurnDestination } from "@/core/turn/inbox";
import { findTurnReplies } from "@/core/turn/replies";
import { juniorTurnOutbox } from "@/db/schema";

/**
 * Adds an outbox row for each reply of the Turn that has none, but only while
 * the Turn has a Destination. Call it in the transaction that commits the
 * replies.
 */
export async function recordReplies(
  { executor }: Pick<EngineContext, "executor">,
  turn: { conversationId: string; turnId: string },
): Promise<void> {
  const destination = await findTurnDestination({ executor }, turn.turnId);
  if (!destination) {
    return;
  }
  const replies = await findTurnReplies(
    { executor },
    turn.conversationId,
    turn.turnId,
  );
  if (replies.length === 0) {
    return;
  }
  await executor
    .db()
    .insert(juniorTurnOutbox)
    .values(
      replies.map((row) => ({
        id: randomUUID(),
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        eventSeq: row.seq,
        destination,
        state: "pending" as const,
      })),
    )
    .onConflictDoNothing({
      target: [juniorTurnOutbox.conversationId, juniorTurnOutbox.eventSeq],
    });
}

type StalledDelivery = {
  conversationId: string;
  turnId: string;
  stalledMs: number;
};

/**
 * Finds Conversations whose first pending reply has not changed for
 * `staleMs`, so no delivery message is likely to reach it. A row behind a
 * first row that is still retried waits; it is not stalled.
 */
export async function findStalledDeliveries(
  { executor }: Pick<EngineContext, "executor">,
  { staleMs, limit }: { staleMs: number; limit: number },
): Promise<StalledDelivery[]> {
  const staleBefore = sql`now() - make_interval(secs => ${staleMs / 1000})`;
  const earlier = alias(juniorTurnOutbox, "earlier");
  const rows = await executor
    .db()
    .select({
      conversationId: juniorTurnOutbox.conversationId,
      turnId: juniorTurnOutbox.turnId,
      updatedAt: juniorTurnOutbox.updatedAt,
    })
    .from(juniorTurnOutbox)
    .where(
      and(
        eq(juniorTurnOutbox.state, "pending"),
        // No row is updated before it is created, so this only lets the
        // query use the pending index.
        lt(juniorTurnOutbox.createdAt, staleBefore),
        lt(juniorTurnOutbox.updatedAt, staleBefore),
        notExists(
          executor
            .db()
            .select({ one: sql`1` })
            .from(earlier)
            .where(
              and(
                eq(earlier.conversationId, juniorTurnOutbox.conversationId),
                eq(earlier.state, "pending"),
                lt(earlier.eventSeq, juniorTurnOutbox.eventSeq),
              ),
            ),
        ),
      ),
    )
    .limit(limit);
  const nowMs = Date.now();
  return rows.map((row) => ({
    conversationId: row.conversationId,
    turnId: row.turnId,
    stalledMs: Math.max(0, nowMs - row.updatedAt.getTime()),
  }));
}
