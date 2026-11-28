// Write each Guardian eval case's decisions, one row per case and results
// file, so a comparison of arms shows where they disagree.
//
// Usage: node guardian-cases.mjs <arm> <out.tsv> <results.json>...
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [arm, out, ...files] = process.argv.slice(2);
if (!arm || !out || files.length === 0) {
  throw new Error(
    "Usage: guardian-cases.mjs <arm> <out.tsv> <results.json>...",
  );
}

// A failed single-call case throws
// "Guardian decided <decision> (... rule=<rule>) ...".
function failedDecision(message) {
  const match = /Guardian decided (\w+) \([^)]*rule=([\w-]+)/.exec(message);
  if (!match) return clean(message).slice(0, 200);
  return match[2] === "none" ? match[1] : `${match[1]} (${match[2]})`;
}

const clean = (text) => String(text).replace(/[\t\n]+/g, " ");
const rows = [
  ["arm", "results", "file", "case", "expected", "decided", "pass"],
];
for (const file of files) {
  const results = JSON.parse(readFileSync(file, "utf8"));
  for (const suite of results.testResults) {
    for (const test of suite.assertionResults) {
      const output = test.meta?.harness?.run?.output ?? {};
      const decided = output.decisions
        ? output.decisions.map((sample) => sample.join(", ")).join(" / ")
        : output.decision
          ? `${output.decision}${output.rule && output.rule !== "none" ? ` (${output.rule})` : ""}`
          : failedDecision(test.failureMessages?.[0] ?? "");
      const expected = output.expected
        ? output.expected.join(", ")
        : output.expectedDecision
          ? [output.expectedDecision].flat().join("|")
          : (/; expected ([a-z| ]+?)\s*$/m
              .exec(test.failureMessages?.[0] ?? "")?.[1]
              ?.replaceAll(" or ", "|") ?? "");
      rows.push([
        arm,
        path.basename(file),
        path.basename(suite.name),
        clean(test.title),
        clean(expected),
        clean(decided),
        test.status === "passed" ? "pass" : "fail",
      ]);
    }
  }
}
writeFileSync(out, `${rows.map((row) => row.join("\t")).join("\n")}\n`);
