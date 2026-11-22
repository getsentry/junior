import { describe, expect } from "vitest";
import { describeEval } from "vitest-evals";
import { setTimeout as delay } from "node:timers/promises";
import { runEvalWork } from "../../src/eval-work";
import "../../src/eval-cleanup";

let cleaned = false;

// The second case checks that the first case's cleanup ran before it
// started, so the order of the two cases is the contract.
describe("Eval cleanup order", { shuffle: false }, () => {
  describeEval(
    "Eval cleanup",
    {
      harness: {
        name: "cleanup",
        run: (_input: undefined, { signal }) =>
          runEvalWork(async () => {
            await new Promise<void>((resolve) =>
              signal!.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
            // Exceed the old worker watchdog and Vitest's default hook timeout.
            await delay(10_100);
            cleaned = true;
            throw signal!.reason;
          }),
      },
    },
    (it) => {
      it.fails("joins work after the outer Vitest timeout", async ({ run }) => {
        await run(undefined);
      }, 50);

      it("starts the next case only after cleanup", () => {
        expect(cleaned).toBe(true);
      });
    },
  );
});
