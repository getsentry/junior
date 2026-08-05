#!/usr/bin/env node
/**
 * Agent-native Garfield entrypoint.
 *
 * Default (`prepare`): build the slice, classify lanes, write prompts + agent
 * brief. The calling agent owns review → fix → validate → report after this.
 *
 * `--finalize`: merge findings, run validation, emit the pass/blocked report.
 *
 * This is the non-manual path. Prefer it over the Swamp suspend/approve flow
 * when an agent is driving the loop end-to-end.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildBundle,
  classifyLanes,
  createRunId,
  defaultRunDir,
  ensureDir,
  laneFileStem,
  parseArgs,
  readJson,
  renderLanePrompt,
  resolveRepoRoot,
  writeAgentBrief,
  writeJson,
} from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function usage(exitCode = 1) {
  console.error(`Usage:
  node scripts/garfield/run.mjs --goal <text> [options]
  node scripts/garfield/run.mjs --finalize --run-dir <path> [options]

Prepare options:
  --goal <text>          Required slice goal / user intent
  --non-goal <text>      Repeatable non-goal
  --base <ref>           Diff base (default: merge-base with origin/main)
  --run-id <id>          Stable run id (default: generated)
  --run-dir <path>       Output directory (default: .swamp/garfield/<run-id>)
  --repo-root <path>     Repo root (default: discover from cwd)
  --profile core|full    Lane profile (default: core)

Finalize options:
  --run-dir <path>       Required unless .swamp/garfield/last-run.json exists
  --only-required        Only run required validation commands
  --skip-validate        Skip validation (report findings only)
`);
  process.exit(exitCode);
}

function normalizeNonGoals(args) {
  return []
    .concat(args["non-goal"] ?? [])
    .concat(args["non-goals"] ?? [])
    .flatMap((value) => {
      if (Array.isArray(value)) return value;
      if (typeof value === "string") {
        return value.includes(",")
          ? value.split(",").map((part) => part.trim())
          : [value];
      }
      return [];
    })
    .filter((value) => typeof value === "string" && value.length > 0);
}

function runNodeScript(repoRoot, scriptName, scriptArgs, options = {}) {
  const scriptPath = path.join(HERE, scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  const allowed = new Set(options.allowStatuses || [0]);
  if (!allowed.has(result.status ?? 1)) {
    const stderr = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `${scriptName} failed (${result.status}): ${stderr || "no output"}`,
    );
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function parseJsonOutput(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Some scripts print markdown then a JSON trailer.
    const jsonStart = text.lastIndexOf("\n{");
    if (jsonStart >= 0) {
      try {
        return JSON.parse(text.slice(jsonStart + 1));
      } catch {
        return null;
      }
    }
    const firstBrace = text.indexOf("{");
    if (firstBrace >= 0) {
      try {
        return JSON.parse(text.slice(firstBrace));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function resolveRunDir(repoRoot, args) {
  if (typeof args["run-dir"] === "string" && args["run-dir"]) {
    return path.resolve(args["run-dir"]);
  }
  const pointerPath = path.join(repoRoot, ".swamp", "garfield", "last-run.json");
  if (fs.existsSync(pointerPath)) {
    const pointer = readJson(pointerPath);
    if (pointer.runDir) return pointer.runDir;
  }
  return null;
}

function writePromptsAndStubs(runDir, bundle, plan) {
  const promptsDir = path.join(runDir, "prompts");
  const findingsDir = path.join(runDir, "findings");
  ensureDir(promptsDir);
  ensureDir(findingsDir);

  const written = [];
  for (const lane of plan.lanes) {
    if (lane.status !== "applicable") continue;
    const stem = laneFileStem(lane.id);
    const promptPath = path.join(promptsDir, `${stem}.md`);
    const findingPath = path.join(findingsDir, `${stem}.txt`);
    fs.writeFileSync(
      promptPath,
      renderLanePrompt({ bundle, lane, runDir }),
      "utf8",
    );
    // Agent path: leave findings empty so the agent must write them.
    // Do not plant the manual-flow placeholder.
    if (!fs.existsSync(findingPath)) {
      fs.writeFileSync(findingPath, "", "utf8");
    }
    written.push({
      laneId: lane.id,
      title: lane.title,
      modelHint: lane.modelHint,
      promptPath,
      findingPath,
    });
  }

  writeJson(path.join(runDir, "lane-prompts.json"), {
    runId: bundle.runId,
    mode: "agent",
    lanes: written,
  });
  return written;
}

function prepare(args) {
  if (!args.goal || args.goal === true) usage(1);

  const repoRoot = resolveRepoRoot(
    typeof args["repo-root"] === "string" && args["repo-root"]
      ? args["repo-root"]
      : process.cwd(),
  );
  const profile = args.profile === "full" ? "full" : "core";
  const runId =
    typeof args["run-id"] === "string" && args["run-id"]
      ? args["run-id"]
      : createRunId();
  const runDir =
    typeof args["run-dir"] === "string" && args["run-dir"]
      ? path.resolve(args["run-dir"])
      : defaultRunDir(repoRoot, runId);

  ensureDir(runDir);

  const bundle = buildBundle({
    repoRoot,
    goal: String(args.goal),
    nonGoals: normalizeNonGoals(args),
    baseRef:
      typeof args.base === "string" && args.base ? args.base : undefined,
    runId,
  });

  const lanes = classifyLanes(bundle.changedFiles, bundle.policies, {
    profile,
  });
  const applicable = lanes.filter((lane) => lane.status === "applicable");
  const skipped = lanes.filter((lane) => lane.status === "skipped");
  const plan = {
    version: 1,
    runId: bundle.runId,
    contentHash: bundle.contentHash,
    profile,
    mode: "agent",
    lanes,
    applicableLaneIds: applicable.map((lane) => lane.id),
    skippedLaneIds: skipped.map((lane) => lane.id),
  };

  writeJson(path.join(runDir, "bundle.json"), bundle);
  writeJson(path.join(runDir, "run.json"), {
    runId,
    runDir,
    bundlePath: path.join(runDir, "bundle.json"),
    createdAt: bundle.createdAt,
    mode: "agent",
    profile,
  });
  writeJson(path.join(runDir, "lane-plan.json"), plan);
  writePromptsAndStubs(runDir, bundle, plan);
  const brief = writeAgentBrief({ bundle, plan, runDir });

  const pointerDir = path.join(repoRoot, ".swamp", "garfield");
  ensureDir(pointerDir);
  writeJson(path.join(pointerDir, "last-run.json"), {
    ok: true,
    runId,
    runDir,
    bundlePath: path.join(runDir, "bundle.json"),
    mode: "agent",
    profile,
    capturedAt: new Date().toISOString(),
  });

  const summary = {
    ok: true,
    mode: "agent",
    phase: "prepare",
    runId,
    runDir,
    profile,
    goal: bundle.goal,
    changedFiles: bundle.changedFiles.length,
    packages: bundle.packages,
    applicable: applicable.length,
    skipped: skipped.length,
    applicableLaneIds: plan.applicableLaneIds,
    briefPath: brief.briefPath,
    todoPath: brief.todoPath,
    next: [
      "Read agent-brief.md in the run dir.",
      "Review each applicable lane and write findings/*.txt (`none` or finding lines).",
      "Fix blocker/high findings with the smallest intent-preserving edits.",
      `node scripts/garfield/run.mjs --finalize --run-dir ${runDir}`,
      "Reply with garfield: pass|blocked plus residual deferred concerns.",
    ],
  };

  console.log(JSON.stringify(summary, null, 2));
  console.error(`\ngarfield prepare ready: ${runDir}`);
  console.error(`agent brief: ${brief.briefPath}`);
  console.error(
    `applicable lanes (${applicable.length}): ${plan.applicableLaneIds.join(", ")}`,
  );
  return 0;
}

function finalize(args) {
  const repoRoot = resolveRepoRoot(
    typeof args["repo-root"] === "string" && args["repo-root"]
      ? args["repo-root"]
      : process.cwd(),
  );
  const runDir = resolveRunDir(repoRoot, args);
  if (!runDir) {
    console.error(
      "Missing --run-dir and no .swamp/garfield/last-run.json pointer.",
    );
    return 1;
  }
  if (!fs.existsSync(path.join(runDir, "bundle.json"))) {
    console.error(`No bundle.json in ${runDir}`);
    return 1;
  }

  const mergeResult = runNodeScript(
    repoRoot,
    "merge-findings.mjs",
    ["--run-dir", runDir],
    { allowStatuses: [0, 2] },
  );
  const merge = parseJsonOutput(mergeResult.stdout) || {
    ok: false,
    raw: mergeResult.stdout,
  };
  if (mergeResult.status === 2 || merge.ok === false || (merge.pending ?? 0) > 0) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          phase: "finalize",
          error: "findings incomplete",
          runDir,
          pending: merge.pending,
          merge,
        },
        null,
        2,
      ),
    );
    return 2;
  }

  let validation = { ok: true, skipped: true, results: [] };
  if (!args["skip-validate"]) {
    const validateArgs = ["--run-dir", runDir];
    if (args["only-required"]) validateArgs.push("--only-required");
    // validate exits 1 when required checks fail; still want the JSON payload.
    const validateResult = runNodeScript(repoRoot, "validate.mjs", validateArgs, {
      allowStatuses: [0, 1],
    });
    validation = parseJsonOutput(validateResult.stdout) || {
      ok: false,
      raw: validateResult.stdout,
    };
  }

  const reportResult = runNodeScript(
    repoRoot,
    "report.mjs",
    ["--run-dir", runDir],
    { allowStatuses: [0, 1] },
  );
  const report = parseJsonOutput(reportResult.stdout) || {
    ok: false,
    raw: reportResult.stdout,
  };

  const summary = {
    ok: Boolean(report.ok),
    mode: "agent",
    phase: "finalize",
    runDir,
    status: report.status,
    reportMdPath: report.reportMdPath,
    reportJsonPath: report.reportJsonPath,
    merge: {
      findingCount: merge.findingCount,
      clusterCount: merge.clusterCount,
    },
    validation: {
      ok: validation.ok,
      failedRequired: validation.failedRequired || [],
      results: validation.results || [],
    },
  };

  console.log(JSON.stringify(summary, null, 2));
  if (fs.existsSync(path.join(runDir, "report.md"))) {
    console.error(`\n${fs.readFileSync(path.join(runDir, "report.md"), "utf8")}`);
  }
  return summary.ok ? 0 : 1;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage(0);

const code = args.finalize ? finalize(args) : prepare(args);
process.exit(code);
