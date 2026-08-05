#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  buildReport,
  parseArgs,
  readJson,
  writeJson,
} from "./lib.mjs";

function usage(exitCode = 1) {
  console.error(
    "Usage: node scripts/garfield/report.mjs --run-dir <path> [--status pass|blocked]",
  );
  process.exit(exitCode);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage(0);
if (typeof args["run-dir"] !== "string") usage(1);

const runDir = path.resolve(args["run-dir"]);
const bundle = readJson(path.join(runDir, "bundle.json"));
const plan = readJson(path.join(runDir, "lane-plan.json"));

let findings = { clusters: [], pendingLaneIds: [] };
const findingsPath = path.join(runDir, "findings.json");
if (fs.existsSync(findingsPath)) {
  findings = readJson(findingsPath);
}

let validationResults = [];
const validationPath = path.join(runDir, "validation.json");
if (fs.existsSync(validationPath)) {
  validationResults = readJson(validationPath).results || [];
}

const open = (findings.clusters || []).filter((cluster) =>
  ["blocker", "high"].includes(cluster.severity),
);
const failedRequired = validationResults.filter(
  (item) => item.required && !item.ok,
);
const pending = findings.pendingLaneIds || [];

let status = typeof args.status === "string" ? args.status : undefined;
if (!status) {
  status =
    pending.length === 0 && open.length === 0 && failedRequired.length === 0
      ? "pass"
      : "blocked";
}

const report = buildReport({
  bundle,
  lanes: plan.lanes,
  clusters: findings.clusters || [],
  validationResults,
  status,
});

const reportMdPath = path.join(runDir, "report.md");
const reportJsonPath = path.join(runDir, "report.json");
fs.writeFileSync(reportMdPath, `${report.markdown}\n`, "utf8");
writeJson(reportJsonPath, report.json);

console.log(report.markdown);
console.log(
  JSON.stringify(
    {
      ok: status === "pass",
      status,
      reportMdPath,
      reportJsonPath,
    },
    null,
    2,
  ),
);

if (status !== "pass") {
  process.exitCode = 1;
}
