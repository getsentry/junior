import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MIN_PASS_RATE,
  evaluateEvalPassRate,
  formatPercent,
  parseEvalPassRateArgs,
} from "./check-eval-pass-rate.mjs";

test("defaults the floor to 80%", () => {
  assert.equal(DEFAULT_MIN_PASS_RATE, 0.8);
});

test("passes when the suite is at or above the floor", () => {
  assert.deepEqual(evaluateEvalPassRate({ total: 100, failed: 20 }), {
    ok: true,
    passRate: 0.8,
    message:
      "eval pass rate ok: 80/100 passed (80.0%), avg score n/a; floor 80.0%",
  });

  assert.equal(
    evaluateEvalPassRate({
      total: 10,
      failed: 1,
      minPassRate: 0.8,
      scoreAverage: 0.91,
    }).ok,
    true,
  );
});

test("fails when the suite is below the floor", () => {
  const result = evaluateEvalPassRate({
    total: 100,
    failed: 21,
    scoreAverage: 0.74,
  });
  assert.equal(result.ok, false);
  assert.equal(result.passRate, 0.79);
  assert.match(result.message, /below floor/);
  assert.match(result.message, /79\/100 passed \(79\.0%\)/);
  assert.match(result.message, /avg score 0\.74/);
});

test("fails closed on empty or invalid reports", () => {
  assert.equal(evaluateEvalPassRate({ total: 0, failed: 0 }).ok, false);
  assert.equal(evaluateEvalPassRate({ total: 5, failed: 6 }).ok, false);
  assert.equal(
    evaluateEvalPassRate({ total: 5.5, failed: 1 }).ok,
    false,
  );
  assert.equal(
    evaluateEvalPassRate({ total: 5, failed: -1 }).ok,
    false,
  );
  assert.equal(
    evaluateEvalPassRate({ total: 5, failed: 1, minPassRate: 1.5 }).ok,
    false,
  );
});

test("formats percentages with one decimal place", () => {
  assert.equal(formatPercent(0.8), "80.0%");
  assert.equal(formatPercent(0.795), "79.5%");
});

test("parses CLI args for the CI gate", () => {
  assert.deepEqual(
    parseEvalPassRateArgs([
      "--total",
      "103",
      "--failed",
      "12",
      "--min-pass-rate",
      "0.8",
      "--score-average",
      "0.87",
    ]),
    {
      total: 103,
      failed: 12,
      minPassRate: 0.8,
      scoreAverage: 0.87,
    },
  );

  assert.equal(
    parseEvalPassRateArgs([
      "--total",
      "10",
      "--failed",
      "0",
      "--min-pass-rate",
      "0.8",
      "--score-average",
      "n/a",
    ]).scoreAverage,
    null,
  );
});

test("rejects invalid CLI args", () => {
  assert.throws(
    () => parseEvalPassRateArgs(["--total", "10"]),
    /missing required --failed/,
  );
  assert.throws(
    () =>
      parseEvalPassRateArgs([
        "--total",
        "x",
        "--failed",
        "0",
        "--min-pass-rate",
        "0.8",
      ]),
    /invalid total/,
  );
  assert.throws(
    () =>
      parseEvalPassRateArgs([
        "--total",
        "10",
        "--failed",
        "0",
        "--min-pass-rate",
      ]),
    /missing value for --min-pass-rate/,
  );
});
