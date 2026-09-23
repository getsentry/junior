import { afterEach, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { drainEvalWork, runEvalWork } from "../../src/eval-work";

let cleaned = false;
let drainedBeforeReset = false;
afterEach(async (context) => {
  await drainEvalWork(context);
  if (context.signal.aborted) drainedBeforeReset = cleaned;
});

it.fails(
  "joins work after the outer Vitest timeout",
  async ({ signal }) => {
    await runEvalWork(async () => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      // Cleanup deliberately completes after Vitest has rejected the case.
      await delay(300);
      cleaned = true;
      signal.throwIfAborted();
    });
  },
  50,
);

it("starts the next case only after cleanup", () => {
  expect(drainedBeforeReset).toBe(true);
});
