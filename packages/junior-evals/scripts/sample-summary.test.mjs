import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeSamples } from "./sample-summary.mjs";

const file =
  "/home/runner/work/junior/junior/packages/junior-evals/evals/conversation/output.eval.ts";

function sample(statuses) {
  return {
    testResults: [
      {
        name: file,
        status: Object.values(statuses).includes("failed")
          ? "failed"
          : "passed",
        message: "",
        assertionResults: Object.entries(statuses).map(
          ([fullName, status]) => ({
            fullName,
            status,
            failureMessages: status === "failed" ? ["judge score 0.4"] : [],
          }),
        ),
      },
    ],
  };
}

test("counts the passed runs of each case across samples", () => {
  const summary = summarizeSamples([
    sample({ "Replies | short": "passed", "Replies cite": "passed" }),
    sample({ "Replies | short": "failed", "Replies cite": "passed" }),
    sample({ "Replies | short": "pending", "Replies cite": "skipped" }),
  ]);

  assert.equal(
    summary,
    [
      "Sample reports: 3",
      "",
      "| Case | Passed |",
      "| --- | --- |",
      "| evals/conversation/output.eval.ts > Replies \\| short | 1/3 |",
      "| evals/conversation/output.eval.ts > Replies cite | 2/2 |",
    ].join("\n"),
  );
});
