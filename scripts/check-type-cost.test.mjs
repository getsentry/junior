import assert from "node:assert/strict";
import test from "node:test";
import { checkTypeCost, parseMetrics } from "./check-type-cost.mjs";

const PROJECT = "packages/junior";
const BASE = { [PROJECT]: { types: 1_000_000, instantiations: 5_000_000 } };

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

test("allows growth within either limit, any drop, and a new project", () => {
  const actual = {
    // +3% exactly, and +90,000 in a small project.
    [PROJECT]: { types: 1_030_000, instantiations: 4_000_000 },
    "packages/small": { types: 100_000, instantiations: 590_000 },
    "packages/new": { types: 1, instantiations: 1 },
  };
  const base = {
    ...BASE,
    "packages/small": { types: 100_000, instantiations: 500_000 },
  };
  assert.deepEqual(checkTypeCost(actual, base), []);
});

test("names the project, metric, base, value, and delta over budget", () => {
  const actual = { [PROJECT]: { types: 1_000_000, instantiations: 5_200_000 } };
  assert.deepEqual(checkTypeCost(actual, BASE), [
    "packages/junior: instantiations: 5200000 found, base 5000000 (+4.00%, +200000; budget +3.00% or +100000, whichever is larger).",
  ]);
});
