// The last resort for replies that no message will send. A lost Turn-ended
// message leaves its replies pending, so the sweep sends it again for each
// Conversation whose first pending reply belongs to an ended Turn and has not
// changed for a while. A false find costs one message. Each find is a
// warning: a publish or a queue redelivery is failing.
import { and, eq, lt, notExists, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { logWarn } from "@/chat/logging";
import type { EngineContext } from "@/core/engine-context";
import { countMetric, withSpan } from "@/core/telemetry";
import { publishTurnEnded } from "@/core/turn/ended";
import { juniorTurnOutbox, juniorTurns } from "@/db/schema";

// Longer than any delay that delivery asks of the queue, so a reply this old
// is stalled, not waiting for its retry.
const STALE_MS = 5 * 60_000;
const BATCH = 100;

/**
 * Sends the message that a Turn ended again for each Conversation whose
 * replies no message will send.
 */
export async function sweepDeliveries(
  ctx: Pick<EngineContext, "executor" | "queue">,
): Promise<void> {
  await withSpan(
    "delivery.sweep",
    {},
    async (span) => {
      const stalled = await findStalledDeliveries(ctx, {
        staleMs: STALE_MS,
        limit: BATCH,
      });
      for (const delivery of stalled) {
        // oxlint-disable-next-line no-await-in-loop -- The sweep stops at the first failed send, so a down queue fails it once.
        await publishTurnEnded(ctx, {
          conversationId: delivery.conversationId,
          turnId: delivery.turnId,
        });
        countMetric("turn.sweep.requeued", {
          "app.turn.sweep.reason": "delivery_lost",
        });
        logWarn("turn.sweep.requeued", {
          "app.turn.id": delivery.turnId,
          "gen_ai.conversation.id": delivery.conversationId,
          "app.turn.sweep.reason": "delivery_lost",
          "app.turn.sweep.stalled_ms": delivery.stalledMs,
        });
      }
      span.setAttributes({
        "app.turn.sweep.requeued": stalled.length,
        "app.turn.sweep.batch_full": stalled.length === BATCH,
      });
    },
    { newTrace: true },
  );
}

type StalledDelivery = {
  conversationId: string;
  turnId: string;
  stalledMs: number;
};

/**
 * Finds Conversations whose first pending reply belongs to an ended Turn and
 * has not changed for `staleMs` since the later of its last change and the
 * Turn's end. A row behind a first row that is still retried waits; it is
 * not stalled. A row of a running Turn waits for the Turn's end.
 */
async function findStalledDeliveries(
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
    .innerJoin(juniorTurns, eq(juniorTurns.id, juniorTurnOutbox.turnId))
    .where(
      and(
        eq(juniorTurnOutbox.state, "pending"),
        // No row is updated before it is created, so this only lets the
        // query use the pending index.
        lt(juniorTurnOutbox.createdAt, staleBefore),
        lt(juniorTurnOutbox.updatedAt, staleBefore),
        notInArray(juniorTurns.state, ["queued", "running"]),
        lt(juniorTurns.endedAt, staleBefore),
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
