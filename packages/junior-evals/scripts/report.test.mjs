import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { reportEvals } from "./report.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);

async function workspace(t) {
  const root = await mkdtemp(path.join(packageRoot, ".report-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function captureApi(t, respond) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer evk_test");
    assert.equal(options.redirect, "error");
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    return (
      respond?.(requests) ??
      Response.json(
        requests.length === 1
          ? {
              id: "run-1",
              url: "https://evals.sentry.dev/run/run-1",
              scenarios: [],
            }
          : { id: "run-1", reported: 1, total: 1 },
      )
    );
  });
  return requests;
}

async function reportFile(root, name = "results.json") {
  const file = path.join(root, name);
  await writeFile(
    file,
    JSON.stringify({
      startTime: 1700000000000,
      testResults: [
        {
          name: "/home/runner/work/junior/junior/packages/junior-evals/evals/router/routing.eval.ts",
          status: "passed",
          message: "",
          assertionResults: [
            {
              fullName: "Routing chooses standard",
              status: "passed",
              failureMessages: [],
            },
          ],
        },
      ],
    }),
  );
  return file;
}

test("uploads real Vitest artifacts with scores, usage, failures, and PR metadata", async (t) => {
  const root = await workspace(t);
  const report = path.join(root, "results.json");
  const config = path.join(root, "vitest.config.mjs");
  const filename = path.join(root, "sample.test.js");
  await writeFile(
    config,
    `export default { test: { include: ["*.test.js"], reporters: ["json"], outputFile: ${JSON.stringify(report)} } };`,
  );
  await writeFile(
    filename,
    `
    import { test, expect } from "vitest";
    import { createHarness, describeEval } from "vitest-evals";
    const harness = createHarness({
      name: "fixture",
      run: async ({ input }) => ({
        output: { answer: "done" },
        events: [{ type: "message", role: "user", content: input }, { type: "message", role: "assistant", content: "done" }],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, toolCalls: 2, metadata: { costUsd: 0.02, cachedInputTokens: 3, cacheCreationTokens: 1 } }
      })
    });
    describeEval("Example", { harness, judges: [], judgeThreshold: null }, (it) => {
      it("passes", async ({ run, task }) => {
        await run("hello");
        task.meta.eval = { scores: [{ name: "quality", score: 0.8, metadata: { rationale: "Good answer" } }] };
      });
      it("fails an assertion", async ({ run }) => { await run("check"); expect(1).toBe(2); });
      it.skip("skipped", async () => {});
    });
    test("harness error", ({ task }) => {
      task.meta.harness = { run: { session: { events: [] }, usage: {}, errors: [{ message: "Gateway unavailable" }] } };
      throw new Error("Gateway unavailable");
    });
  `,
  );
  const vitest = fileURLToPath(
    new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
  );
  await assert.rejects(
    exec(process.execPath, [vitest, "run", "--config", config], {
      cwd: root,
      env: { ...process.env, SENTRY_EVALS_API_KEY: "" },
    }),
    (error) => error.code === 1,
  );

  // Downloaded shard paths point at the runner checkout, not this machine.
  const artifact = JSON.parse(await readFile(report, "utf8"));
  artifact.testResults[0].name =
    "/home/runner/work/junior/junior/packages/junior-evals/evals/conversation/example.eval.ts";
  artifact.testResults[0].assertionResults[0].meta.harness.run.session.metadata =
    {
      log_records: [{ message: "runtime diagnostic" }],
    };
  await writeFile(report, JSON.stringify(artifact));
  const second = await reportFile(root, "second.json");
  const event = path.join(root, "event.json");
  const summary = path.join(root, "summary.md");
  await writeFile(
    event,
    JSON.stringify({
      pull_request: {
        number: 42,
        html_url: "https://github.com/getsentry/junior/pull/42",
        head: { sha: "head-sha", ref: "feature" },
        base: { sha: "base-sha" },
      },
    }),
  );
  const requests = captureApi(t);
  const url = await reportEvals("behavioral", [report, second], {
    SENTRY_EVALS_API_KEY: "evk_test",
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: event,
    GITHUB_REPOSITORY: "getsentry/junior",
    GITHUB_SHA: "merge-sha",
    GITHUB_ACTOR: "developer",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_STEP_SUMMARY: summary,
  });
  assert.equal(url, "https://evals.sentry.dev/run/run-1");
  assert.match(
    await readFile(summary, "utf8"),
    /\[behavioral\]\(https:\/\/evals.sentry.dev\/run\/run-1\)/,
  );
  assert.equal(requests[0].url, "https://evals.sentry.dev/api/runs");
  const created = requests[0].body;
  assert.equal(created.dataset_name, "junior-behavioral");
  assert.equal(created.name, "junior behavioral / 123 / attempt 2");
  assert.equal(created.created_at, "2023-11-14T22:13:20.000Z");
  assert.equal(created.metadata.result_files, 2);
  assert.deepEqual(created.source, {
    trigger: "pull_request",
    actor: "developer",
    branch: "feature",
    sha: "head-sha",
    base_sha: "base-sha",
    pr_number: 42,
    pr_url: "https://github.com/getsentry/junior/pull/42",
    commit_url: "https://github.com/getsentry/junior/commit/head-sha",
    run_url: "https://github.com/getsentry/junior/actions/runs/123/attempts/2",
  });
  assert.equal(created.scenarios.length, 4);
  assert.ok(created.scenarios.every(({ name }) => name.startsWith("evals/")));
  const uploaded = requests.slice(1).flatMap(({ url, body }) => {
    assert.equal(url, "https://evals.sentry.dev/api/runs/run-1/scenarios");
    assert.equal(body.run_id, "run-1");
    return body.scenarios;
  });
  assert.deepEqual(
    uploaded.map(({ status }) => status),
    ["passed", "failed", "error", "passed"],
  );
  assert.deepEqual(
    uploaded.map(({ name }) => ({ name })),
    created.scenarios,
  );
  assert.deepEqual(uploaded[0].input, [
    { type: "message", role: "user", content: "hello" },
  ]);
  assert.deepEqual(uploaded[0].output.result, { answer: "done" });
  assert.equal(uploaded[0].output.session.events.length, 2);
  assert.equal(uploaded[0].output.session.metadata, undefined);
  assert.deepEqual(uploaded[0].scores, [
    { name: "quality", score: 0.8, label: null, explanation: "Good answer" },
  ]);
  assert.deepEqual(uploaded[0].otel_metrics, {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    tool_calls: 2,
    cost_usd: 0.02,
    cache_read_tokens: 3,
    cache_write_tokens: 1,
  });
  assert.ok(uploaded[0].duration_seconds >= 0);
  assert.match(uploaded[1].error, /expected 1 to be 2/);
  assert.match(uploaded[2].error, /Gateway unavailable/);
});

test("reports file setup failures without turning skipped tests into passes", async (t) => {
  const root = await workspace(t);
  const file = await reportFile(root);
  const report = JSON.parse(await readFile(file, "utf8"));
  report.testResults[0].status = "failed";
  report.testResults[0].message = "beforeAll failed";
  report.testResults[0].assertionResults[0].status = "skipped";
  report.testResults.push({
    name: "/home/runner/work/junior/junior/packages/junior-evals/evals/router/interrupted.eval.ts",
    status: "passed",
    message: "",
    assertionResults: [
      { fullName: "interrupted", status: "pending", failureMessages: [] },
    ],
  });
  await writeFile(file, JSON.stringify(report));
  const requests = captureApi(t);
  await reportEvals("router", [file], { SENTRY_EVALS_API_KEY: "evk_test" });
  assert.equal(requests[2].body.scenarios[0].status, "error");
  assert.match(requests[2].body.scenarios[0].error, /did not finish/);
  assert.deepEqual(requests[1].body.scenarios, [
    {
      name: "evals/router/routing.eval.ts > [file error]",
      status: "error",
      input: null,
      error: "beforeAll failed",
      attributes: { file: "evals/router/routing.eval.ts" },
    },
  ]);
});

test("does not contact the API without a key or with duplicate scenarios", async (t) => {
  const root = await workspace(t);
  const file = await reportFile(root);
  const requests = captureApi(t);
  await reportEvals("router", ["missing.json"], {});
  await assert.rejects(
    reportEvals("router", [file, file], { SENTRY_EVALS_API_KEY: "evk_test" }),
    /Duplicate scenario names/,
  );
  assert.equal(requests.length, 0);
});

test("surfaces an upload failure without retrying or printing server content", async (t) => {
  const root = await workspace(t);
  const file = await reportFile(root);
  const requests = captureApi(t, (requests) =>
    requests.length === 2
      ? new Response("sensitive server content", { status: 503 })
      : undefined,
  );
  await assert.rejects(
    reportEvals("router", [file], { SENTRY_EVALS_API_KEY: "evk_test" }),
    {
      message: "Sentry Evals POST /api/runs/run-1/scenarios failed (HTTP 503)",
    },
  );
  assert.equal(requests.length, 2);
});

test("rejects a silently ignored scenario", async (t) => {
  const root = await workspace(t);
  const file = await reportFile(root);
  captureApi(t, (requests) =>
    requests.length === 2
      ? Response.json({ id: "run-1", reported: 0, total: 1 })
      : undefined,
  );
  await assert.rejects(
    reportEvals("router", [file], { SENTRY_EVALS_API_KEY: "evk_test" }),
    /did not accept scenario/,
  );
});
