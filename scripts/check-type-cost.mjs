import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { typecheckProjects } from "./lib/typecheck-projects.mjs";

/**
 * Type-check cost ratchet. It runs every project that `pnpm typecheck` runs,
 * so CI runs it in place of `pnpm typecheck`. It compares the type and
 * instantiation counts from `tsc --diagnostics` with a committed
 * per-project baseline. These counts measure checker work and are the same on
 * every run. Check time and memory change from run to run, so they are not
 * compared.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TSC = path.join(REPO_ROOT, "node_modules/.bin/tsc");
const BASELINE_PATH = "scripts/type-cost-baseline.json";
// The counts change by 0% from run to run. Adding a file moves other files
// to other checkers, which changed them by 0.04% in a test. The rest of the
// budget is room for normal code growth, so a change that costs much more
// fails.
const TOLERANCE = 0.03;
const METRICS = { types: "Types", instantiations: "Instantiations" };
const TSC_ARGS = [
  "--noEmit",
  "--diagnostics",
  // An incremental run reuses earlier results and reports lower counts.
  "--incremental",
  "false",
  // Each checker has its own type cache, so the counts depend on the number
  // of checkers. Pin it so every machine reports the same counts.
  "--checkers",
  "4",
];
const HOW_TO_FIX = [
  `Find the cause: run \`node_modules/.bin/tsc --noEmit -p <project> --singleThreaded --generateTrace /tmp/trace\` on this branch and on main, then compare the slowest checkSourceFile and checkExpression events in /tmp/trace/trace.json (open it in https://ui.perfetto.dev).`,
  `Raise the baseline only when the cost is worth it: the change adds a check or a feature that a cheaper type cannot give, a dependency upgrade adds it, or earlier changes used the budget and this change adds little compared with main. Run \`pnpm type-cost:update\`, and open a pull request that changes only ${BASELINE_PATH}, with the reason and the trace numbers. Merge it first.`,
];

/** Read the counted metrics from `tsc --diagnostics` output. */
export function parseMetrics(output) {
  const metrics = {};
  for (const [key, label] of Object.entries(METRICS)) {
    const match = new RegExp(`^${label}:\\s+(\\d+)$`, "m").exec(output);
    if (!match) throw new Error(`No "${label}" line in tsc output.`);
    metrics[key] = Number(match[1]);
  }
  return metrics;
}

function percent(value) {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

/**
 * Report each project metric that is over its baseline by more than the
 * tolerance, and each project that is missing from the baseline or no longer
 * runs. A lower count passes.
 */
export function checkTypeCost(actual, baseline) {
  const errors = [];
  for (const [project, metrics] of Object.entries(actual)) {
    const allowed = baseline[project];
    if (!allowed) {
      errors.push(
        `${project}: no baseline. Run \`pnpm type-cost:update\` and commit ${BASELINE_PATH}.`,
      );
      continue;
    }
    for (const [metric, value] of Object.entries(metrics)) {
      const delta = (value - allowed[metric]) / allowed[metric];
      if (delta > TOLERANCE) {
        errors.push(
          `${project}: ${metric}: ${value} found, baseline ${allowed[metric]} (${percent(delta)}, budget ${percent(TOLERANCE)}).`,
        );
      }
    }
  }
  for (const project of Object.keys(baseline)) {
    if (!actual[project]) {
      errors.push(
        `${project}: \`pnpm typecheck\` no longer runs this project. Remove its entry from ${BASELINE_PATH}.`,
      );
    }
  }
  return errors;
}

/**
 * Report baseline values that are higher than in the base commit, when the
 * same change also edits other files. A raise must be its own change, so a
 * reviewer sees it and the cost it accepts.
 */
export function checkBaselineRaise(previous, current, changedFiles) {
  if (changedFiles.every((file) => file === BASELINE_PATH)) return [];
  const errors = [];
  for (const [project, metrics] of Object.entries(current)) {
    for (const [metric, value] of Object.entries(metrics)) {
      const before = previous[project]?.[metric];
      if (before !== undefined && value > before) {
        errors.push(
          `${project}: ${metric}: baseline raised from ${before} to ${value} in a change that also edits other files.`,
        );
      }
    }
  }
  return errors;
}

function typecheck(project) {
  return new Promise((resolve, reject) => {
    const child = spawn(TSC, [...TSC_ARGS, "-p", project], { cwd: REPO_ROOT });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ project, code, output }));
  });
}

// Four at a time ran fastest on a 4-vCPU machine, as CI uses.
async function typecheckAll(projects) {
  const results = [];
  const queue = [...projects];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length > 0) results.push(await typecheck(queue.shift()));
  });
  await Promise.all(workers);
  return results;
}

function git(...args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

// CI sets TYPE_COST_BASE to the base branch commit. Locally, compare with
// the merge base of origin/main.
function baseCommit() {
  const base = process.env.TYPE_COST_BASE;
  return base
    ? git("rev-parse", base)
    : git("merge-base", "HEAD", "origin/main");
}

function baselineAt(commit) {
  if (!git("ls-tree", "--name-only", commit, "--", BASELINE_PATH)) return {};
  return JSON.parse(git("show", `${commit}:${BASELINE_PATH}`));
}

async function main() {
  const update = process.argv.includes("--update");
  const { projects, errors: projectErrors } = typecheckProjects(REPO_ROOT);
  if (projectErrors.length > 0) {
    console.error(projectErrors.join("\n"));
    process.exitCode = 1;
    return;
  }

  const baseline = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, BASELINE_PATH), "utf8"),
  );
  // Start the most expensive projects first, so the run ends sooner.
  projects.sort(
    (a, b) =>
      (baseline[b]?.instantiations ?? 0) - (baseline[a]?.instantiations ?? 0),
  );
  const actual = {};
  let typeErrors = false;
  for (const { project, code, output } of await typecheckAll(projects)) {
    if (code !== 0) {
      console.error(`${project}: tsc failed:\n${output}`);
      typeErrors = true;
      continue;
    }
    actual[project] = parseMetrics(output);
  }
  if (typeErrors) {
    process.exitCode = 1;
    return;
  }
  const sorted = Object.fromEntries(
    Object.keys(actual)
      .sort()
      .map((project) => [project, actual[project]]),
  );

  if (update) {
    fs.writeFileSync(
      path.join(REPO_ROOT, BASELINE_PATH),
      `${JSON.stringify(sorted, null, 2)}\n`,
    );
    console.log(`Wrote ${BASELINE_PATH}.`);
    return;
  }

  for (const [project, metrics] of Object.entries(sorted)) {
    const deltas = Object.entries(metrics).map(([metric, value]) => {
      const allowed = baseline[project]?.[metric];
      return `${metric} ${value}${allowed ? ` (${percent((value - allowed) / allowed)})` : ""}`;
    });
    console.log(`${project}: ${deltas.join(", ")}`);
  }

  const commit = baseCommit();
  const errors = [
    ...checkTypeCost(sorted, baseline),
    ...checkBaselineRaise(
      baselineAt(commit),
      baseline,
      git("diff", "--name-only", commit).split("\n").filter(Boolean),
    ),
  ];
  if (errors.length === 0) {
    console.log("Type-check cost is within the baseline.");
    return;
  }
  console.error(
    ["Type-check cost check failed:", ...errors, ...HOW_TO_FIX].join("\n"),
  );
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
