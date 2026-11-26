import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeGuardianDesign } from "./guardian-design-summary.mjs";

function assertion(title, output) {
  return {
    title,
    failureMessages: output ? [] : ["Error: harness crashed"],
    meta: output ? { harness: { run: { output } } } : {},
  };
}

test("groups sample results by rule and category, and lists cases that do not pass", () => {
  const summary = summarizeGuardianDesign({
    testResults: [
      {
        assertionResults: [
          assertion("[must-name/false-ask] a named PR", {
            category: "false-ask",
            passes: 3,
            rule: "must-name",
            samples: 3,
          }),
          assertion("[must-name/control] an unnamed reviewer", {
            category: "control",
            passes: 1,
            rule: "must-name",
            samples: 3,
          }),
          assertion("[bounded-failure/abort] the model is down", undefined),
        ],
      },
    ],
  });

  assert.match(summary, /3 cases\. 1 pass on every sample\./);
  assert.match(summary, /Sample pass rate: 57% \(4\/7\)/);
  assert.match(summary, /\| `must-name` \| 2 \| 1 \| 1 \| 0 \| 67% \|/);
  assert.match(summary, /\| `bounded-failure` \| 1 \| 0 \| 0 \| 1 \| 0% \|/);
  assert.match(summary, /\| `abort` \| 1 \| 0 \| 0 \| 1 \| 0% \|/);
  assert.match(summary, /- flaky 1\/3: \[must-name\/control\]/);
  assert.match(summary, /- fail 0\/1: \[bounded-failure\/abort\]/);
  assert.doesNotMatch(summary, /- pass/);
});

test("rejects a report with no cases", () => {
  assert.throws(
    () => summarizeGuardianDesign({ testResults: [] }),
    /no Guardian design cases/,
  );
});
