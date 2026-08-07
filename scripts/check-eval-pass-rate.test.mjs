import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CHECK_NAME,
  DEFAULT_MIN_PASS_RATE,
  evalPassRateAnnotation,
  evalPassRateCheckSummary,
  evalPassRateCheckTitle,
  evaluateEvalPassRate,
  formatPercent,
  parseEvalPassRateArgs,
  publishEvalScoreCheck,
} from "./check-eval-pass-rate.mjs";

test("defaults the floor to 80%", () => {
  assert.equal(DEFAULT_MIN_PASS_RATE, 0.8);
  assert.equal(DEFAULT_CHECK_NAME, "eval score");
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
  assert.equal(evaluateEvalPassRate({ total: 5.5, failed: 1 }).ok, false);
  assert.equal(evaluateEvalPassRate({ total: 5, failed: -1 }).ok, false);
  assert.equal(
    evaluateEvalPassRate({ total: 5, failed: 1, minPassRate: 1.5 }).ok,
    false,
  );
});

test("formats percentages with one decimal place", () => {
  assert.equal(formatPercent(0.8), "80.0%");
  assert.equal(formatPercent(0.795), "79.5%");
});

test("builds PR check title and workflow annotation text", () => {
  const result = evaluateEvalPassRate({
    total: 102,
    failed: 37,
    minPassRate: 0.8,
    scoreAverage: 0.72,
  });

  assert.equal(
    evalPassRateCheckTitle(result, 0.8),
    "63.7% passed · required 80.0%",
  );
  assert.equal(
    evalPassRateAnnotation(result, 0.8),
    "::error title=63.7%25 passed · required 80.0%25::eval pass rate below floor: 65/102 passed (63.7%25), avg score 0.72; required >= 80.0%25",
  );
  assert.match(evalPassRateCheckSummary(result, 0.8), /result: failed/);
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
      "--publish-check",
      "true",
      "--soft-fail",
      "true",
      "--check-name",
      "eval score",
    ]),
    {
      total: 103,
      failed: 12,
      minPassRate: 0.8,
      scoreAverage: 0.87,
      checkName: "eval score",
      publishCheck: true,
      softFail: true,
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

test("publishes a completed Check Run with the custom title", async () => {
  /** @type {RequestInit | undefined} */
  let request;
  const published = await publishEvalScoreCheck({
    token: "token",
    repository: "getsentry/junior",
    sha: "abc123",
    name: "eval score",
    title: "63.7% passed · required 80.0%",
    summary: "## Eval Pass Rate\n",
    conclusion: "failure",
    detailsUrl: "https://github.com/getsentry/junior/actions/runs/1",
    apiUrl: "https://api.github.example",
    fetchImpl: async (url, init) => {
      assert.equal(
        url,
        "https://api.github.example/repos/getsentry/junior/check-runs",
      );
      request = init;
      return {
        ok: true,
        async json() {
          return {
            id: 99,
            html_url: "https://github.com/getsentry/junior/runs/99",
          };
        },
      };
    },
  });

  assert.deepEqual(published, {
    id: 99,
    htmlUrl: "https://github.com/getsentry/junior/runs/99",
  });
  assert.equal(request?.method, "POST");
  const body = JSON.parse(String(request?.body));
  assert.equal(body.name, "eval score");
  assert.equal(body.head_sha, "abc123");
  assert.equal(body.conclusion, "failure");
  assert.equal(body.output.title, "63.7% passed · required 80.0%");
  assert.equal(
    body.details_url,
    "https://github.com/getsentry/junior/actions/runs/1",
  );
});
