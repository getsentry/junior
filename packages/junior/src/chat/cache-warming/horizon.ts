/** Send the horizon messages that end an idle period. */
import { IDLE_HORIZON_MS } from "./model";
import { sendCacheWarmup } from "./queue";

/**
 * Send the horizon message of one step of an idle period that started at
 * `sinceMs`. A queue signature outlives one `IDLE_HORIZON_MS`, so each step
 * ends that long after the last, and the last step ends at `horizonMs`.
 */
export async function sendCacheWarmingHorizon(input: {
  conversationId: string;
  generation: string;
  sinceMs: number;
  horizonMs: number;
  step: number;
}): Promise<void> {
  const dueIdleMs = Math.min(input.step * IDLE_HORIZON_MS, input.horizonMs);
  await sendCacheWarmup(
    {
      kind: "horizon",
      conversationId: input.conversationId,
      generation: input.generation,
      ...(input.step > 1 ? { step: input.step } : undefined),
    },
    input.sinceMs + dueIdleMs - Date.now(),
  );
}
