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
    // A drop, and +20,000 (+20%) in a small project.
    [PROJECT]: { types: 990_000, instantiations: 4_000_000 },
    "packages/small": { types: 120_000, instantiations: 120_000 },
    "packages/new": { types: 1, instantiations: 1 },
  };
  const base = {
    ...BASE,
    "packages/small": { types: 100_000, instantiations: 100_000 },
  };
  assert.deepEqual(checkTypeCost(actual, base), []);
});

test("names the project, metric, base, value, and delta over budget", () => {
  const actual = { [PROJECT]: { types: 1_000_000, instantiations: 5_200_000 } };
  assert.deepEqual(checkTypeCost(actual, BASE), [
    "packages/junior: instantiations: 5200000 found, base 5000000 (+4.00%, +200000; budget +3.00% or +25000, whichever is larger).",
    "all projects: instantiations: 5200000 found, base 5000000 (+4.00%, +200000; budget +2.00%).",
  ]);
});

test("rejects growth spread over many projects", () => {
  const base = {};
  const actual = {};
  for (let i = 0; i < 10; i++) {
    base[`packages/p${i}`] = { types: 100_000, instantiations: 400_000 };
    actual[`packages/p${i}`] = { types: 100_000, instantiations: 424_000 };
  }
  assert.deepEqual(checkTypeCost(actual, base), [
    "all projects: instantiations: 4240000 found, base 4000000 (+6.00%, +240000; budget +2.00%).",
  ]);
});
