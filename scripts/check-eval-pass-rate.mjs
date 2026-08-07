import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const DEFAULT_MIN_PASS_RATE = 0.8;
export const DEFAULT_CHECK_NAME = "eval score";

/**
 * Decide whether a combined eval report meets the configured pass-rate floor.
 *
 * @param {{
 *   total: number;
 *   failed: number;
 *   minPassRate?: number;
 *   scoreAverage?: number | null;
 * }} input
 */
export function evaluateEvalPassRate(input) {
  const total = input.total;
  const failed = input.failed;
  const minPassRate = input.minPassRate ?? DEFAULT_MIN_PASS_RATE;
  const scoreAverage = input.scoreAverage;

  if (!Number.isInteger(total) || total < 0) {
    return {
      ok: false,
      passRate: null,
      message: `invalid evals total: ${String(total)}`,
    };
  }
  if (!Number.isInteger(failed) || failed < 0) {
    return {
      ok: false,
      passRate: null,
      message: `invalid evals failed count: ${String(failed)}`,
    };
  }
  if (failed > total) {
    return {
      ok: false,
      passRate: null,
      message: `failed count ${failed} exceeds total ${total}`,
    };
  }
  if (!Number.isFinite(minPassRate) || minPassRate < 0 || minPassRate > 1) {
    return {
      ok: false,
      passRate: null,
      message: `invalid min pass rate: ${String(minPassRate)}`,
    };
  }
  if (total === 0) {
    return {
      ok: false,
      passRate: null,
      message: "no eval cases were reported",
    };
  }

  const passed = total - failed;
  const passRate = passed / total;
  const scoreText =
    scoreAverage == null || !Number.isFinite(scoreAverage)
      ? "n/a"
      : scoreAverage.toFixed(2);
  const counts = `${passed}/${total} passed (${formatPercent(passRate)}), avg score ${scoreText}`;

  if (passRate + Number.EPSILON < minPassRate) {
    return {
      ok: false,
      passRate,
      message: `eval pass rate below floor: ${counts}; required >= ${formatPercent(minPassRate)}`,
    };
  }

  return {
    ok: true,
    passRate,
    message: `eval pass rate ok: ${counts}; floor ${formatPercent(minPassRate)}`,
  };
}

/** Format a 0-1 ratio as a percentage with one decimal place. */
export function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Short status text for the PR checks list via Check Run output.title.
 *
 * Workflow jobs cannot customize that secondary line; only a Checks API run can.
 */
export function evalPassRateCheckTitle(result, minPassRate) {
  if (result.passRate === null) {
    return result.ok ? "Eval score gate passed" : "Eval score gate failed";
  }
  if (result.ok) {
    return `${formatPercent(result.passRate)} passed · floor ${formatPercent(minPassRate)}`;
  }
  return `${formatPercent(result.passRate)} passed · required ${formatPercent(minPassRate)}`;
}

/** Build the titled GitHub workflow annotation for a failed score gate. */
export function evalPassRateAnnotation(result, minPassRate) {
  const title = evalPassRateCheckTitle(result, minPassRate);
  return `::error title=${escapeWorkflowCommandProperty(title)}::${escapeWorkflowCommandData(result.message)}`;
}

/** Markdown body for the Check Run detail page / job summary. */
export function evalPassRateCheckSummary(result, minPassRate) {
  return [
    "## Eval Pass Rate",
    "",
    `- result: ${result.ok ? "passed" : "failed"}`,
    `- ${result.message}`,
    `- floor: ${formatPercent(minPassRate)}`,
    "",
  ].join("\n");
}

/** Escape GitHub workflow-command message data. */
export function escapeWorkflowCommandData(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

/** Escape GitHub workflow-command property data. */
export function escapeWorkflowCommandProperty(value) {
  return escapeWorkflowCommandData(value)
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

/**
 * Parse CLI args for the CI gate.
 *
 * @param {string[]} argv
 */
export function parseEvalPassRateArgs(argv) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) {
      throw new Error(`unexpected argument: ${String(arg)}`);
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    values[key] = value;
    index += 1;
  }

  for (const key of ["total", "failed", "min-pass-rate"]) {
    if (!(key in values)) {
      throw new Error(`missing required --${key}`);
    }
  }

  return {
    total: parseCount(values.total, "total"),
    failed: parseCount(values.failed, "failed"),
    minPassRate: parseRatio(values["min-pass-rate"], "min-pass-rate"),
    scoreAverage: parseOptionalScore(values["score-average"]),
    checkName: values["check-name"]?.trim() || DEFAULT_CHECK_NAME,
    publishCheck: parseBooleanFlag(values["publish-check"], false),
    // When a Check Run owns the PR status line, keep the workflow job green so
    // GitHub does not also show a canned "Failing after Xs" job row.
    softFail: parseBooleanFlag(values["soft-fail"], false),
  };
}

/**
 * @param {string} value
 * @param {string} name
 */
function parseCount(value, name) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return Number(value);
}

/**
 * @param {string} value
 * @param {string} name
 */
function parseRatio(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return parsed;
}

/**
 * @param {string | undefined} value
 */
function parseOptionalScore(value) {
  if (value === undefined || value === "" || value.toLowerCase() === "n/a") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid score-average: ${value}`);
  }
  return parsed;
}

/**
 * @param {string | undefined} value
 * @param {boolean} defaultValue
 */
function parseBooleanFlag(value, defaultValue) {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const normalized = value.toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new Error(`invalid boolean: ${value}`);
}

/**
 * Publish a completed GitHub Check Run so the PR checks list can show a custom
 * secondary title instead of the workflow job's canned "Failing after Xs".
 *
 * @param {{
 *   token: string;
 *   repository: string;
 *   sha: string;
 *   name: string;
 *   title: string;
 *   summary: string;
 *   conclusion: "success" | "failure";
 *   detailsUrl?: string;
 *   apiUrl?: string;
 *   fetchImpl?: typeof fetch;
 * }} options
 */
export async function publishEvalScoreCheck(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const [owner, repo] = options.repository.split("/");
  if (!owner || !repo) {
    throw new Error(`invalid GitHub repository: ${options.repository}`);
  }

  const apiUrl = options.apiUrl ?? "https://api.github.com";
  const response = await fetchImpl(
    `${apiUrl}/repos/${owner}/${repo}/check-runs`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        name: options.name,
        head_sha: options.sha,
        status: "completed",
        conclusion: options.conclusion,
        completed_at: new Date().toISOString(),
        ...(options.detailsUrl ? { details_url: options.detailsUrl } : {}),
        output: {
          title: options.title.slice(0, 1024),
          summary: options.summary.slice(0, 64_000),
        },
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitHub Check Run request failed: ${response.status} ${response.statusText} ${text}`.trim(),
    );
  }

  const data = /** @type {{ id?: number; html_url?: string }} */ (
    await response.json()
  );
  return {
    id: data.id,
    htmlUrl: data.html_url,
  };
}

function detailsUrlFromEnv(env = process.env) {
  const server = env.GITHUB_SERVER_URL?.replace(/\/$/, "");
  const repository = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  if (!server || !repository || !runId) {
    return undefined;
  }
  return `${server}/${repository}/actions/runs/${runId}`;
}

/**
 * Resolve the commit SHA the Check Run should attach to.
 *
 * On `pull_request`, `GITHUB_SHA` is the temporary merge commit. PR status and
 * required checks are tied to the head commit, so prefer an explicit head SHA
 * (workflow-provided or from the event payload) before falling back.
 */
export function resolveCheckSha(env = process.env) {
  const explicit =
    env.EVAL_CHECK_SHA?.trim() ||
    env.GITHUB_PR_HEAD_SHA?.trim() ||
    env.GITHUB_HEAD_SHA?.trim();
  if (explicit) {
    return explicit;
  }

  const eventPath = env.GITHUB_EVENT_PATH?.trim();
  if (eventPath) {
    try {
      const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
      const headSha = event?.pull_request?.head?.sha;
      if (typeof headSha === "string" && headSha.trim()) {
        return headSha.trim();
      }
    } catch {
      // Fall through to GITHUB_SHA when the event payload is unavailable.
    }
  }

  return env.GITHUB_SHA?.trim() || undefined;
}

async function main() {
  try {
    const input = parseEvalPassRateArgs(process.argv.slice(2));
    const result = evaluateEvalPassRate(input);
    const title = evalPassRateCheckTitle(result, input.minPassRate);
    const summary = evalPassRateCheckSummary(result, input.minPassRate);
    console.log(result.message);

    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      fs.appendFileSync(summaryPath, `${summary}\n`);
    }

    if (input.publishCheck) {
      const token = process.env.GITHUB_TOKEN?.trim();
      const repository = process.env.GITHUB_REPOSITORY?.trim();
      const sha = resolveCheckSha();
      if (!token || !repository || !sha) {
        throw new Error(
          "publish-check requires GITHUB_TOKEN, GITHUB_REPOSITORY, and a head commit SHA (EVAL_CHECK_SHA or pull_request.head.sha)",
        );
      }
      const published = await publishEvalScoreCheck({
        token,
        repository,
        sha,
        name: input.checkName,
        title,
        summary,
        conclusion: result.ok ? "success" : "failure",
        detailsUrl: detailsUrlFromEnv(),
        apiUrl: process.env.GITHUB_API_URL,
      });
      if (published.htmlUrl) {
        console.log(`published check run: ${published.htmlUrl}`);
      } else if (published.id !== undefined) {
        console.log(`published check run id: ${published.id}`);
      }
    }

    if (!result.ok) {
      console.error(evalPassRateAnnotation(result, input.minPassRate));
      if (!input.softFail) {
        process.exitCode = 1;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `::error title=Eval score gate failed::${escapeWorkflowCommandData(message)}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
