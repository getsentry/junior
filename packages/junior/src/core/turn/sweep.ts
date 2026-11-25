// The last resort for work that no queue message will reach. Every change
// of a Turn writes first and publishes its message after, so a crash between
// the two leaves the Turn waiting forever. The same holds for a reply's
// outbox row and its delivery message. The sweep sends that message again. A
// step message sent twice claims nothing, and a delivery message sent twice
// finds nothing left to send, so a false find costs one message. Each find is
// a warning: when the sweep finds work, a publish or a queue redelivery is
// failing.
import { logWarn } from "@/chat/logging";
import { findStalledDeliveries } from "@/core/delivery/outbox";
import { publishDelivery } from "@/core/delivery/queue";
import type { EngineContext } from "@/core/engine-context";
import { countMetric, withSpan } from "@/core/telemetry";
import { publishTurnStep } from "@/core/turn/queue";
import { findStalledTurns } from "@/core/turn/state";

// Longer than any delay that core asks of the queue, so a Turn this old is
// stalled, not waiting.
const STALE_MS = 5 * 60_000;
const BATCH = 100;

/**
 * Sends the step message again for each Turn that no message will reach, and
 * the delivery message again for each Conversation whose replies no message
 * will send.
 */
export async function sweepTurns(
  ctx: Pick<EngineContext, "executor" | "queue">,
): Promise<void> {
  await withSpan(
    "turn.sweep",
    {},
    async (span) => {
      const turns = await findStalledTurns(ctx, {
        staleMs: STALE_MS,
        limit: BATCH,
      });
      for (const turn of turns) {
        // oxlint-disable-next-line no-await-in-loop -- The sweep stops at the first failed send, so a down queue fails it once.
        await publishTurnStep(ctx, turn.turnId);
        reportRequeued(turn);
      }
      const deliveries = await findStalledDeliveries(ctx, {
        staleMs: STALE_MS,
        limit: BATCH,
      });
      for (const delivery of deliveries) {
        // oxlint-disable-next-line no-await-in-loop -- The sweep stops at the first failed send, so a down queue fails it once.
        await publishDelivery(ctx, {
          conversationId: delivery.conversationId,
          turnId: delivery.turnId,
        });
        reportRequeued({ ...delivery, reason: "delivery_lost" });
      }
      span.setAttributes({
        "app.turn.sweep.requeued": turns.length + deliveries.length,
        "app.turn.sweep.batch_full":
          turns.length === BATCH || deliveries.length === BATCH,
      });
    },
    { newTrace: true },
  );
}

function reportRequeued(found: {
  turnId: string;
  conversationId: string;
  reason: string;
  stalledMs: number;
}): void {
  countMetric("turn.sweep.requeued", {
    "app.turn.sweep.reason": found.reason,
  });
  logWarn("turn.sweep.requeued", {
    "app.turn.id": found.turnId,
    "gen_ai.conversation.id": found.conversationId,
    "app.turn.sweep.reason": found.reason,
    "app.turn.sweep.stalled_ms": found.stalledMs,
  });
}
