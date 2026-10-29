import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { scenariosFromReport } from "./report.mjs";

// Each report is one live sample of the same eval cases. A case that a sample
// did not finish counts as a run that did not pass.

/** Return a Markdown table with the passed runs of each case across samples. */
export function summarizeSamples(reports) {
  const cases = new Map();
  for (const report of reports) {
    for (const { name, status } of scenariosFromReport(report)) {
      const counts = cases.get(name) ?? { passed: 0, runs: 0 };
      counts.runs += 1;
      if (status === "passed") counts.passed += 1;
      cases.set(name, counts);
    }
  }
  return [
    `Sample reports: ${reports.length}`,
    "",
    "| Case | Passed |",
    "| --- | --- |",
    ...[...cases].map(
      ([name, { passed, runs }]) =>
        `| ${name.replaceAll("|", "\\|")} | ${passed}/${runs} |`,
    ),
  ].join("\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    throw new Error("Usage: sample-summary.mjs <results.json> [...]");
  }
  const reports = await Promise.all(
    files.map(async (file) => JSON.parse(await readFile(file, "utf8"))),
  );
  console.log(summarizeSamples(reports));
}
