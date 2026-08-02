#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  mergeFindings,
  parseArgs,
  parseFindings,
  readJson,
  writeJson,
} from "./lib.mjs";

function usage(exitCode = 1) {
  console.error(
    "Usage: node scripts/garfield/merge-findings.mjs --run-dir <path>",
  );
  process.exit(exitCode);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage(0);
if (typeof args["run-dir"] !== "string") usage(1);

const runDir = path.resolve(args["run-dir"]);
const plan = readJson(path.join(runDir, "lane-plan.json"));
const findingsDir = path.join(runDir, "findings");
const all = [];
const perLane = [];

for (const lane of plan.lanes) {
  if (lane.status !== "applicable") continue;
  const safeName = lane.id
    .replace(/\.md$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "__");
  const findingPath = path.join(findingsDir, `${safeName}.txt`);
  if (!fs.existsSync(findingPath)) {
    perLane.push({
      laneId: lane.id,
      status: "missing",
      findingPath,
      findings: [],
    });
    continue;
  }
  const text = fs.readFileSync(findingPath, "utf8");
  const placeholder = text.trim().startsWith("# Replace this file");
  if (placeholder || !text.trim()) {
    perLane.push({
      laneId: lane.id,
      status: "pending",
      findingPath,
      findings: [],
    });
    continue;
  }
  const findings = parseFindings(text, lane.id);
  all.push(...findings);
  perLane.push({
    laneId: lane.id,
    status: "ready",
    findingPath,
    findings,
  });
}

const clusters = mergeFindings(all.filter((finding) => finding.valid !== false));
const pending = perLane.filter((lane) => lane.status !== "ready");

writeJson(path.join(runDir, "findings.json"), {
  runId: plan.runId,
  pendingLaneIds: pending.map((lane) => lane.laneId),
  lanes: perLane,
  findings: all,
  clusters,
});

console.log(
  JSON.stringify(
    {
      ok: pending.length === 0,
      runId: plan.runId,
      pending: pending.length,
      findingCount: all.length,
      clusterCount: clusters.length,
      findingsPath: path.join(runDir, "findings.json"),
    },
    null,
    2,
  ),
);

if (pending.length > 0) {
  process.exitCode = 2;
}
