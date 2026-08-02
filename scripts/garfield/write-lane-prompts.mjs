#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  ensureDir,
  parseArgs,
  readJson,
  renderLanePrompt,
  writeJson,
} from "./lib.mjs";

function usage(exitCode = 1) {
  console.error(
    "Usage: node scripts/garfield/write-lane-prompts.mjs --run-dir <path>",
  );
  process.exit(exitCode);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage(0);
if (typeof args["run-dir"] !== "string") usage(1);

const runDir = path.resolve(args["run-dir"]);
const bundle = readJson(path.join(runDir, "bundle.json"));
const plan = readJson(path.join(runDir, "lane-plan.json"));
const promptsDir = path.join(runDir, "prompts");
const findingsDir = path.join(runDir, "findings");
ensureDir(promptsDir);
ensureDir(findingsDir);

const written = [];
for (const lane of plan.lanes) {
  if (lane.status !== "applicable") continue;
  const safeName = lane.id
    .replace(/\.md$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "__");
  const promptPath = path.join(promptsDir, `${safeName}.md`);
  const findingPath = path.join(findingsDir, `${safeName}.txt`);
  fs.writeFileSync(promptPath, renderLanePrompt({ bundle, lane, runDir }), "utf8");
  if (!fs.existsSync(findingPath)) {
    fs.writeFileSync(
      findingPath,
      "# Replace this file with reviewer output (`none` or finding lines).\n",
      "utf8",
    );
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
  lanes: written,
});

console.log(
  JSON.stringify(
    {
      ok: true,
      runId: bundle.runId,
      promptCount: written.length,
      promptsDir,
      findingsDir,
      lanes: written.map((lane) => ({
        id: lane.laneId,
        modelHint: lane.modelHint,
        promptPath: lane.promptPath,
        findingPath: lane.findingPath,
      })),
    },
    null,
    2,
  ),
);
