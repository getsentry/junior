import assert from "node:assert/strict";
import test from "node:test";
import { checkTypeCost, parseMetrics } from "./check-type-cost.mjs";

const PROJECT = "packages/junior";
const BASE = { [PROJECT]: { types: 1000, instantiations: 2000 } };

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

test("allows growth within the tolerance, any drop, and a new project", () => {
  const actual = {
    [PROJECT]: { types: 1030, instantiations: 1500 },
    "packages/new": { types: 1, instantiations: 1 },
  };
  assert.deepEqual(checkTypeCost(actual, BASE), []);
});

test("names the project, metric, base, value, and delta over budget", () => {
  const actual = { [PROJECT]: { types: 1000, instantiations: 2080 } };
  assert.deepEqual(checkTypeCost(actual, BASE), [
    "packages/junior: instantiations: 2080 found, base 2000 (+4.00%, budget +3.00%).",
  ]);
});
