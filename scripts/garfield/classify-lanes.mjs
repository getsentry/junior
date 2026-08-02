#!/usr/bin/env node
import path from "node:path";
import {
  classifyLanes,
  parseArgs,
  readJson,
  writeJson,
} from "./lib.mjs";

function usage(exitCode = 1) {
  console.error(
    "Usage: node scripts/garfield/classify-lanes.mjs --run-dir <path>",
  );
  process.exit(exitCode);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage(0);
if (typeof args["run-dir"] !== "string") usage(1);

const runDir = path.resolve(args["run-dir"]);
const bundle = readJson(path.join(runDir, "bundle.json"));
const lanes = classifyLanes(bundle.changedFiles, bundle.policies);
const applicable = lanes.filter((lane) => lane.status === "applicable");
const skipped = lanes.filter((lane) => lane.status === "skipped");

const plan = {
  version: 1,
  runId: bundle.runId,
  contentHash: bundle.contentHash,
  lanes,
  applicableLaneIds: applicable.map((lane) => lane.id),
  skippedLaneIds: skipped.map((lane) => lane.id),
};

writeJson(path.join(runDir, "lane-plan.json"), plan);

console.log(
  JSON.stringify(
    {
      ok: true,
      runId: bundle.runId,
      applicable: applicable.length,
      skipped: skipped.length,
      applicableLaneIds: plan.applicableLaneIds,
      planPath: path.join(runDir, "lane-plan.json"),
    },
    null,
    2,
  ),
);
