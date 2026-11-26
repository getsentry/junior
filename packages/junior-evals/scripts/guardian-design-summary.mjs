// Write the Guardian design baseline as Markdown: pass rates by rule ID and
// by failure category, and the cases that do not pass. A case passes when
// each of its samples meets the design, and is flaky when only some do.
//
// Usage: node scripts/guardian-design-summary.mjs <results.json>
// It prints the summary, and adds it to the GitHub job summary in CI.
import { appendFile, readFile } from "node:fs/promises";
import { env } from "node:process";
import { pathToFileURL } from "node:url";

function caseResult(assertion) {
  const output = assertion.meta?.harness?.run?.output;
  // The title starts with `[rule/category]`. A case whose harness crashed
  // has no output, so it keeps its tags from the title and fails.
  const [, rule = "unknown", category = "unknown"] =
    assertion.title.match(/^\[([^/\]]+)\/([^\]]+)\]/) ?? [];
  return {
    category: output?.category ?? category,
    name: assertion.title,
    passes: output?.passes ?? 0,
    rule: output?.rule ?? rule,
    samples: output?.samples ?? 1,
  };
}

function status(entry) {
  if (entry.passes === entry.samples) return "pass";
  return entry.passes > 0 ? "flaky" : "fail";
}

function percent(part, whole) {
  return `${Math.round((part / whole) * 100)}%`;
}

function sampleTotals(entries) {
  return {
    passes: entries.reduce((sum, entry) => sum + entry.passes, 0),
    samples: entries.reduce((sum, entry) => sum + entry.samples, 0),
  };
}

function table(cases, key, label) {
  const groups = Map.groupBy(cases, (entry) => entry[key]);
  const rows = [...groups]
    .map(([name, group]) => {
      const { passes, samples } = sampleTotals(group);
      const count = (wanted) =>
        group.filter((entry) => status(entry) === wanted).length;
      return {
        line: `| \`${name}\` | ${group.length} | ${count("pass")} | ${count("flaky")} | ${count("fail")} | ${percent(passes, samples)} |`,
        rate: passes / samples,
      };
    })
    .sort((left, right) => left.rate - right.rate);
  return [
    `| ${label} | Cases | Pass | Flaky | Fail | Sample pass rate |`,
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((row) => row.line),
  ];
}

/** Render the Markdown summary of one Vitest JSON report of the suite. */
export function summarizeGuardianDesign(report) {
  const cases = report.testResults.flatMap((result) =>
    result.assertionResults.map(caseResult),
  );
  if (cases.length === 0) {
    throw new Error("The report has no Guardian design cases.");
  }
  const { passes, samples } = sampleTotals(cases);
  const passing = cases.filter((entry) => status(entry) === "pass").length;
  const others = cases.filter((entry) => status(entry) !== "pass");
  return [
    "## Guardian design baseline",
    "",
    `${cases.length} cases. ${passing} pass on every sample. Sample pass rate: ${percent(passes, samples)} (${passes}/${samples}).`,
    "",
    ...table(cases, "rule", "Rule"),
    "",
    ...table(cases, "category", "Category"),
    "",
    "Cases that do not pass on every sample:",
    "",
    ...(others.length > 0
      ? others.map(
          (entry) =>
            `- ${status(entry)} ${entry.passes}/${entry.samples}: ${entry.name}`,
        )
      : ["- none"]),
    "",
  ].join("\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const summary = summarizeGuardianDesign(
    JSON.parse(await readFile(process.argv[2], "utf8")),
  );
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, summary);
  }
}
