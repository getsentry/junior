import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const DEFAULT_MIN_PASS_RATE = 0.8;

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

/** Build the titled GitHub annotation shown on a failed score-gate check. */
export function evalPassRateAnnotation(result, minPassRate) {
  const title =
    result.passRate === null
      ? "Eval score gate failed"
      : `Eval pass rate ${formatPercent(result.passRate)} — required ${formatPercent(minPassRate)}`;
  return `::error title=${escapeWorkflowCommandProperty(title)}::${escapeWorkflowCommandData(result.message)}`;
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

function main() {
  try {
    const input = parseEvalPassRateArgs(process.argv.slice(2));
    const result = evaluateEvalPassRate(input);
    console.log(result.message);

    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      fs.appendFileSync(
        summaryPath,
        [
          "## Eval Pass Rate",
          "",
          `- result: ${result.ok ? "passed" : "failed"}`,
          `- ${result.message}`,
          "",
        ].join("\n") + "\n",
      );
    }

    if (!result.ok) {
      console.error(evalPassRateAnnotation(result, input.minPassRate));
      process.exitCode = 1;
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
  main();
}
