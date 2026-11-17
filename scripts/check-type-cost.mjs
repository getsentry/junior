import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { typecheckProjects } from "./lib/typecheck-projects.mjs";

/**
 * Type-check cost check. It runs every project that `pnpm typecheck` runs,
 * so CI runs it in place of `pnpm typecheck`. It reads the type and
 * instantiation counts from `tsc --diagnostics`. These counts measure
 * checker work and are the same on every run. Check time and memory change
 * from run to run, so they are not compared.
 *
 * When TYPE_COST_FILE holds the counts of the base commit, a project whose
 * counts grow past the budget fails. The check then writes this run's
 * counts to TYPE_COST_FILE. CI keeps that file for each `main` commit,
 * so a pull request compares only its own change.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TSC = path.join(REPO_ROOT, "node_modules/.bin/tsc");
// The counts change by 0% from run to run, and by 0.04% when a new file
// moves other files to other checkers. A project fails when a count grows
// by more than 3% and by more than 25,000. In 35 recent pull requests, two
// failed: Sentry card features added about 90,000 instantiations (+17-19%)
// to junior-sentry. The sum over all projects fails when it grows by more
// than 2%, so a type that many projects use cannot pass in small parts. The
// largest sum growth was 1.46%, in getsentry/junior#3477.
const PROJECT_TOLERANCE = 0.03;
const PROJECT_MIN_GROWTH = 25_000;
const TOTAL_TOLERANCE = 0.02;
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
const ACCEPT_LABEL = "Type-Cost-Accepted";
const HOW_TO_FIX = [
  "Find the cause: run `node_modules/.bin/tsc --noEmit -p <project> --singleThreaded --generateTrace /tmp/trace` on this branch and on main, then compare the slowest checkSourceFile and checkExpression events in /tmp/trace/trace.json (open it in https://ui.perfetto.dev).",
  `If the cost is worth it, explain why in the pull request, add the \`${ACCEPT_LABEL}\` label, then re-run this job.`,
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
 * Report each project metric, and each metric summed over the projects, that
 * grew past its budget since the base counts. A project without base counts
 * is new and is not compared.
 */
export function checkTypeCost(actual, base) {
  const errors = [];
  const totals = {};
  for (const [project, metrics] of Object.entries(actual)) {
    for (const [metric, value] of Object.entries(metrics)) {
      const before = base[project]?.[metric];
      if (!before) continue;
      totals[metric] ??= { value: 0, before: 0 };
      totals[metric].value += value;
      totals[metric].before += before;
      const delta = (value - before) / before;
      if (delta > PROJECT_TOLERANCE && value - before > PROJECT_MIN_GROWTH) {
        errors.push(
          `${project}: ${metric}: ${value} found, base ${before} (${percent(delta)}, +${value - before}; budget ${percent(PROJECT_TOLERANCE)} or +${PROJECT_MIN_GROWTH}, whichever is larger).`,
        );
      }
    }
  }
  for (const [metric, { value, before }] of Object.entries(totals)) {
    const delta = (value - before) / before;
    if (delta > TOTAL_TOLERANCE) {
      errors.push(
        `all projects: ${metric}: ${value} found, base ${before} (${percent(delta)}, +${value - before}; budget ${percent(TOTAL_TOLERANCE)}).`,
      );
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

// CI passes the pull request number and a read-only token. The labels are
// read at run time, so a re-run sees a label that was added after the run.
async function acceptedByLabel() {
  const pullRequest = process.env.TYPE_COST_PR;
  if (!pullRequest) return false;
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/pulls/${pullRequest}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `Reading the labels of pull request ${pullRequest} failed: HTTP ${response.status}`,
    );
  }
  const { labels } = await response.json();
  return labels.some((label) => label.name === ACCEPT_LABEL);
}

function git(...args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

async function main() {
  const { projects, errors: projectErrors } = typecheckProjects(REPO_ROOT);
  if (projectErrors.length > 0) {
    console.error(projectErrors.join("\n"));
    process.exitCode = 1;
    return;
  }

  const file = process.env.TYPE_COST_FILE;
  const base =
    file && fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : undefined;
  // Start the most expensive projects first, so the run ends sooner.
  projects.sort(
    (a, b) =>
      (base?.projects[b]?.instantiations ?? 0) -
      (base?.projects[a]?.instantiations ?? 0),
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
  for (const [project, metrics] of Object.entries(sorted)) {
    const deltas = Object.entries(metrics).map(([metric, value]) => {
      const before = base?.projects[project]?.[metric];
      return `${metric} ${value}${before ? ` (${percent((value - before) / before)})` : ""}`;
    });
    console.log(`${project}: ${deltas.join(", ")}`);
  }
  if (file) {
    fs.writeFileSync(
      file,
      `${JSON.stringify({ commit: git("rev-parse", "HEAD"), projects: sorted }, null, 2)}\n`,
    );
  }

  if (!base) {
    console.log(
      "Type-check cost not compared: no counts from a main commit are available.",
    );
    return;
  }
  const expected = process.env.TYPE_COST_BASE_SHA;
  const fallback =
    expected && expected !== base.commit
      ? `These counts come from the newest main entry (${base.commit}), not from the base commit (${expected}), so the deltas also include the main commits between them. Re-run this job after the base commit's \`check / types\` job on main finishes.`
      : undefined;
  console.log(
    fallback ?? `Compared with the counts of main at ${base.commit}.`,
  );
  const errors = checkTypeCost(sorted, base.projects);
  if (errors.length === 0) {
    console.log("No project grew past the type-check cost budget.");
    return;
  }
  if (await acceptedByLabel()) {
    for (const error of errors) {
      console.log(`::warning::Accepted by the ${ACCEPT_LABEL} label: ${error}`);
    }
    return;
  }
  console.error(
    [
      "Type-check cost check failed:",
      ...errors,
      ...(fallback ? [fallback] : []),
      ...HOW_TO_FIX,
    ].join("\n"),
  );
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
