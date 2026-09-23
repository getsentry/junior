import { expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { runEvalWork } from "../../src/eval-work";
import "../../src/eval-cleanup";

let cleaned = false;

it.fails(
  "joins work after the outer Vitest timeout",
  async ({ signal }) => {
    await runEvalWork(async () => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      // Exceed the old worker watchdog and Vitest's default hook timeout.
      await delay(10_100);
      cleaned = true;
      signal.throwIfAborted();
    });
  },
  50,
);

it("starts the next case only after cleanup", () => {
  expect(cleaned).toBe(true);
});
