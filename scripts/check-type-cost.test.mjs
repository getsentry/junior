import assert from "node:assert/strict";
import test from "node:test";
import {
  checkBaselineRaise,
  checkTypeCost,
  parseMetrics,
} from "./check-type-cost.mjs";

const BASELINE_PATH = "scripts/type-cost-baseline.json";
const PROJECT = "packages/junior";
const BASELINE = { [PROJECT]: { types: 1000, instantiations: 2000 } };

test("reads the counted metrics from tsc diagnostics", () => {
  const output = [
    "Files:                   6114",
    "Symbols:               3911470",
    "Types:                 1455108",
    "Instantiations:        5714471",
    "Check time:            9.358s",
  ].join("\n");
  assert.deepEqual(parseMetrics(output), {
    types: 1455108,
    instantiations: 5714471,
  });
  assert.throws(() => parseMetrics("Files: 1"), /No "Types" line/);
});

test("allows growth within the tolerance and any drop", () => {
  const actual = { [PROJECT]: { types: 1030, instantiations: 1500 } };
  assert.deepEqual(checkTypeCost(actual, BASELINE), []);
});

test("names the project, metric, baseline, value, and delta over budget", () => {
  const actual = { [PROJECT]: { types: 1000, instantiations: 2080 } };
  assert.deepEqual(checkTypeCost(actual, BASELINE), [
    "packages/junior: instantiations: 2080 found, baseline 2000 (+4.00%, budget +3.00%).",
  ]);
});

test("rejects a project without a baseline and a stale baseline entry", () => {
  const errors = checkTypeCost(
    { "packages/new": { types: 1, instantiations: 1 } },
    BASELINE,
  );
  assert.equal(errors.length, 2);
  assert.match(
    errors[0],
    /^packages\/new: no baseline\. Run `pnpm type-cost:update`/,
  );
  assert.match(errors[1], /^packages\/junior: `pnpm typecheck` no longer runs/);
});

test("rejects a baseline raise in a change that edits other files", () => {
  const raised = { [PROJECT]: { types: 1000, instantiations: 2100 } };
  assert.deepEqual(
    checkBaselineRaise(BASELINE, raised, [BASELINE_PATH, "src/a.ts"]),
    [
      "packages/junior: instantiations: baseline raised from 2000 to 2100 in a change that also edits other files.",
    ],
  );
});

test("allows a baseline raise on its own, a drop, and a new project", () => {
  const raised = { [PROJECT]: { types: 1000, instantiations: 2100 } };
  assert.deepEqual(checkBaselineRaise(BASELINE, raised, [BASELINE_PATH]), []);
  const lowered = {
    [PROJECT]: { types: 900, instantiations: 2000 },
    "packages/new": { types: 1, instantiations: 1 },
  };
  assert.deepEqual(
    checkBaselineRaise(BASELINE, lowered, [BASELINE_PATH, "src/a.ts"]),
    [],
  );
});
