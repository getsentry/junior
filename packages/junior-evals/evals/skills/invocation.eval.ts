import { describe, expect } from "vitest";
import { mention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { test } from "@junior-evals/fixture/test";

describe("Skills", () => {
  test("when an explicit skill runs twice in one thread, keep its replies ordered", async ({
    run,
  }) => {
    const brief = (incident: string) =>
      rubric({
        pass: [
          `The reply is an incident brief about ${incident}.`,
          "The reply contains the requested incident name, Investigating status, and On-call owner.",
        ],
      });

    const first = await run(mention("/incident-brief Checkout latency"));
    await expect(first.evalRun).toSatisfyJudge(
      RubricJudge,
      brief("Checkout latency"),
    );
    const second = await first.continue(
      mention("/incident-brief Search errors"),
    );
    await expect(second.evalRun).toSatisfyJudge(
      RubricJudge,
      brief("Search errors"),
    );

    expect(first.replies).toHaveLength(1);
    expect(second.replies).toHaveLength(1);
  });
});
