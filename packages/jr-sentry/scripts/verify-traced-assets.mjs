import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const traceFile = path.join(
  projectRoot,
  ".next",
  "server",
  "app",
  ".well-known",
  "workflow",
  "v1",
  "step",
  "route.js.nft.json"
);

if (!fs.existsSync(traceFile)) {
  throw new Error(`Missing workflow step trace file: ${traceFile}`);
}

const parsed = JSON.parse(fs.readFileSync(traceFile, "utf8"));
const files = Array.isArray(parsed.files) ? parsed.files : [];
const hasSoul = files.some((entry) => /(^|\/)data\/SOUL\.md$/.test(entry));

if (!hasSoul) {
  throw new Error(
    [
      "Build trace is missing data/SOUL.md for workflow step route.",
      "The deployment may fail with ENOENT for SOUL.md.",
      `Trace checked: ${traceFile}`
    ].join(" ")
  );
}

console.log("Verified traced assets: data/SOUL.md is included.");
