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
// A project fails only when a count grows by more than both limits. The
// counts change by 0% from run to run, and by 0.04% when a new file moves
// other files to other checkers. In 35 recent pull requests, only small
// projects grew by more than 3%, by at most 90,000 instantiations. The
// largest projects grew by at most 2%, in getsentry/junior#3477.
const TOLERANCE = 0.03;
const MIN_GROWTH = 100_000;
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
const ACCEPT_TRAILER = "Type-Cost-Accepted";
const HOW_TO_FIX = [
  "Find the cause: run `node_modules/.bin/tsc --noEmit -p <project> --singleThreaded --generateTrace /tmp/trace` on this branch and on main, then compare the slowest checkSourceFile and checkExpression events in /tmp/trace/trace.json (open it in https://ui.perfetto.dev).",
  `If the cost is worth it, add a \`${ACCEPT_TRAILER}: <reason>\` trailer to the last commit of the pull request, and ask a reviewer to confirm the trade.`,
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
 * Report each project metric that grew past both limits since the base
 * counts. A project without base counts is new and is not compared.
 */
export function checkTypeCost(actual, base) {
  const errors = [];
  for (const [project, metrics] of Object.entries(actual)) {
    for (const [metric, value] of Object.entries(metrics)) {
      const before = base[project]?.[metric];
      if (!before) continue;
      const delta = (value - before) / before;
      if (delta > TOLERANCE && value - before > MIN_GROWTH) {
        errors.push(
          `${project}: ${metric}: ${value} found, base ${before} (${percent(delta)}, +${value - before}; budget ${percent(TOLERANCE)} or +${MIN_GROWTH}, whichever is larger).`,
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

// CI checks out a merge commit, whose second parent is the pull request
// head. Locally, HEAD is the last commit.
function acceptedReason() {
  const parents = git("log", "-1", "--format=%P", "HEAD").split(" ");
  const commit = parents.length > 1 ? "HEAD^2" : "HEAD";
  return git(
    "log",
    "-1",
    `--format=%(trailers:key=${ACCEPT_TRAILER},valueonly,separator=%x2C )`,
    commit,
  );
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
  console.log(`Compared with the counts of main at ${base.commit}.`);
  if (expected && expected !== base.commit) {
    console.log(
      `The base commit is ${expected}, so the deltas also include the main commits between them.`,
    );
  }
  const errors = checkTypeCost(sorted, base.projects);
  if (errors.length === 0) {
    console.log("No project grew past the type-check cost budget.");
    return;
  }
  const reason = acceptedReason();
  if (reason) {
    console.log(
      [...errors, `Accepted by the ${ACCEPT_TRAILER} trailer: ${reason}`].join(
        "\n",
      ),
    );
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
