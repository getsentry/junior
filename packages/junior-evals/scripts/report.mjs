import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Upload completed Vitest artifacts, not live runtime state. Each suite has one
// run across all shards. Keep CI gates and artifact storage independent.
const API_URL = "https://evals.sentry.dev";
const SUITES = ["behavioral", "integration", "guardian", "router"];
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function scenarioFile(filename) {
  const normalized = filename.replaceAll("\\", "/");
  const marker = "/packages/junior-evals/";
  const file = normalized.includes(marker)
    ? normalized.slice(normalized.lastIndexOf(marker) + marker.length)
    : path.relative(packageRoot, filename).replaceAll("\\", "/");
  if (!file.startsWith("evals/")) {
    throw new Error(`Expected an eval file inside junior-evals: ${filename}`);
  }
  return file;
}

/** Map the Vitest assertion and its vitest-evals metadata to the API schema. */
function scenarioResult(file, assertion) {
  const run = assertion.meta?.harness?.run;
  const evaluation = assertion.meta?.eval;
  const usage = run?.usage;
  const metadata = usage?.metadata;
  const harnessErrors = run?.errors ?? [];
  const failed = assertion.status === "failed";
  const unfinished = assertion.status === "pending";
  return {
    name: `${file} > ${assertion.fullName}`,
    status:
      unfinished || harnessErrors.length > 0
        ? "error"
        : failed
          ? "failed"
          : "passed",
    input:
      run?.session.events.filter(
        (event) => event.type === "message" && event.role === "user",
      ) ?? null,
    output: run
      ? {
          result: run.output ?? evaluation?.output ?? null,
          // Session metadata includes runtime logs. Send only the transcript.
          session: { events: run.session.events },
        }
      : (evaluation?.output ?? null),
    error:
      [
        ...assertion.failureMessages,
        ...harnessErrors.map((error) => error.message),
        ...(unfinished
          ? ["Test did not finish before Vitest wrote the report"]
          : []),
      ]
        .filter(Boolean)
        .join("\n") || null,
    scores: (evaluation?.scores ?? []).map((score, index) => ({
      name: score.name ?? `judge-${index + 1}`,
      score: score.score ?? null,
      label:
        typeof score.metadata?.label === "string" ? score.metadata.label : null,
      explanation:
        typeof score.metadata?.rationale === "string"
          ? score.metadata.rationale
          : null,
    })),
    attributes: {
      file,
      test: assertion.fullName,
      ...(usage?.model ? { model: usage.model } : {}),
      ...(usage?.provider ? { provider: usage.provider } : {}),
    },
    duration_seconds: (assertion.duration ?? 0) / 1000,
    otel_metrics: usage
      ? {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
          reasoning_tokens: usage.reasoningTokens,
          tool_calls: usage.toolCalls,
          cache_read_tokens: metadata?.cachedInputTokens,
          cache_write_tokens: metadata?.cacheCreationTokens,
          cost_usd: metadata?.costUsd,
        }
      : null,
  };
}

/** Exclude intentional skips. Report file setup failures as separate errors. */
function scenariosFromReport(report) {
  if (!Array.isArray(report.testResults)) {
    throw new Error("Expected a Vitest JSON report with testResults");
  }
  return report.testResults.flatMap((result) => {
    const file = scenarioFile(result.name);
    const scenarios = result.assertionResults.flatMap((assertion) => {
      if (["skipped", "todo", "disabled"].includes(assertion.status)) return [];
      if (
        !["passed", "failed", "pending"].includes(assertion.status) ||
        !assertion.fullName
      ) {
        throw new Error(`Invalid assertion in ${file}`);
      }
      return [scenarioResult(file, assertion)];
    });
    if (
      result.status === "failed" &&
      (result.message || !scenarios.some(({ status }) => status !== "passed"))
    ) {
      scenarios.push({
        name: `${file} > [file error]`,
        status: "error",
        input: null,
        error:
          result.message ||
          "Vitest reported a file or suite failure without a test error",
        attributes: { file },
      });
    }
    return scenarios;
  });
}

/** Use PR head metadata instead of the merge commit checked out by Actions. */
async function sourceFromEnvironment(env) {
  const event = env.GITHUB_EVENT_PATH
    ? JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"))
    : {};
  const pr = event.pull_request;
  const repositoryUrl = env.GITHUB_REPOSITORY
    ? `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}`
    : null;
  const sha = pr?.head.sha ?? env.GITHUB_SHA ?? null;
  return {
    trigger: env.GITHUB_ACTIONS === "true" ? env.GITHUB_EVENT_NAME : "local",
    actor: env.GITHUB_ACTOR ?? null,
    branch: pr?.head.ref ?? env.GITHUB_REF_NAME ?? null,
    sha,
    base_sha: pr?.base.sha ?? null,
    pr_number: pr?.number ?? null,
    pr_url: pr?.html_url ?? null,
    commit_url: repositoryUrl && sha ? `${repositoryUrl}/commit/${sha}` : null,
    run_url:
      repositoryUrl && env.GITHUB_RUN_ID
        ? `${repositoryUrl}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT ?? "1"}`
        : null,
  };
}

/** Bound network waits and never retry creation: the API has no idempotency key. */
async function post(endpoint, body, apiKey) {
  const response = await fetch(`${API_URL}${endpoint}`, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    // Do not print server bodies: they can echo credentials or result content.
    throw new Error(
      `Sentry Evals POST ${endpoint} failed (HTTP ${response.status})`,
    );
  }
  return response.json();
}

/** Publish one suite from all its JSON artifacts. Missing keys opt out safely. */
export async function reportEvals(suite, files, env = process.env) {
  if (!SUITES.includes(suite) || files.length === 0) {
    throw new Error(
      "Usage: report.mjs <behavioral|integration|guardian|router> <results.json> [...]",
    );
  }
  const apiKey = env.SENTRY_EVALS_API_KEY?.trim();
  if (!apiKey) {
    console.log(
      "Sentry Evals upload skipped: SENTRY_EVALS_API_KEY is not set.",
    );
    return;
  }

  const reports = await Promise.all(
    files.map(async (file) => JSON.parse(await readFile(file, "utf8"))),
  );
  const scenarios = reports.flatMap(scenariosFromReport);
  if (scenarios.length === 0)
    throw new Error("No completed eval scenarios to upload");
  if (new Set(scenarios.map(({ name }) => name)).size !== scenarios.length) {
    throw new Error(
      "Duplicate scenario names: refusing to overwrite eval results",
    );
  }
  const source = await sourceFromEnvironment(env);
  const createdAt = new Date(
    Math.min(...reports.map((report) => report.startTime)),
  ).toISOString();
  const run = await post(
    "/api/runs",
    {
      dataset_name: `junior-${suite}`,
      name: `junior ${suite}${env.GITHUB_RUN_ID ? ` / ${env.GITHUB_RUN_ID} / attempt ${env.GITHUB_RUN_ATTEMPT ?? "1"}` : " / local"}`,
      created_at: createdAt,
      source,
      metadata: {
        repository: env.GITHUB_REPOSITORY ?? null,
        result_files: files.length,
      },
      scenarios: scenarios.map(({ name }) => ({ name })),
    },
    apiKey,
  );
  if (typeof run.id !== "string" || !run.id)
    throw new Error("Sentry Evals returned no run id");
  const url = `${API_URL}/run/${encodeURIComponent(run.id)}`;
  console.log(`Sentry Evals run: ${url}`);
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `\nSentry Evals: [${suite}](${url})\n`,
    );
  }

  // One scenario per request bounds transcript payloads and allows partial
  // progress if an upload fails. Re-running this command creates a new run.
  for (const scenario of scenarios) {
    const result = await post(
      `/api/runs/${encodeURIComponent(run.id)}/scenarios`,
      {
        run_id: run.id,
        scenarios: [scenario],
      },
      apiKey,
    );
    if (result.id !== run.id || result.reported !== 1 || result.total !== 1) {
      throw new Error(`Sentry Evals did not accept scenario: ${scenario.name}`);
    }
  }
  console.log(`Uploaded ${scenarios.length} scenarios to ${url}`);
  return url;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await reportEvals(process.argv[2], process.argv.slice(3));
}
