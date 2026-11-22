import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Pick the dashboard e2e burn-in for a pull request. CI then runs each
 * selected test 10 times with no retries, so a new flaky test fails before
 * it merges.
 *
 * Playwright `--only-changed=BASE_SHA` selects the spec files that changed
 * since the base commit, and the spec files that import a changed file. A
 * change to a shared helper, such as `e2e/test.ts`, selects most of the
 * suite. Above `MAX_TESTS` the burn-in does not run, and the full dashboard
 * e2e job still tests the change. Writes `run=true|false` to GITHUB_OUTPUT.
 *
 * Reads BASE_SHA and the Playwright config path DASHBOARD_E2E_CONFIG. The
 * dashboard must be built first: some specs import built packages.
 */

// One run takes about 2 seconds on two workers, so 30 tests times 10 runs
// take about 10 minutes. The largest spec file has 24 tests.
const MAX_TESTS = 30;

/** Count the tests and list the spec files in a Playwright JSON list report. */
export function countTests(report) {
  const files = new Set();
  let tests = 0;
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      // One entry for each project that runs the spec.
      tests += spec.tests.length;
      files.add(spec.file);
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites) visit(suite);
  return { files: [...files].sort(), tests };
}

function main() {
  const base = process.env["BASE_SHA"];
  const config = process.env["DASHBOARD_E2E_CONFIG"];
  const output = process.env["GITHUB_OUTPUT"];
  if (!base || !config || !output) {
    throw new Error("Set BASE_SHA, DASHBOARD_E2E_CONFIG, and GITHUB_OUTPUT.");
  }
  const reportPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "burn-in-")),
    "list.json",
  );
  execFileSync(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      `--config=${config}`,
      "--list",
      "--reporter=json",
      `--only-changed=${base}`,
    ],
    {
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath },
      // The JSON report holds the list. Keep errors on stderr.
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  const { files, tests } = countTests(
    JSON.parse(fs.readFileSync(reportPath, "utf8")),
  );
  const run = tests > 0 && tests <= MAX_TESTS;
  fs.appendFileSync(output, `run=${run}\n`);
  if (tests === 0) {
    console.log("No dashboard e2e test changed.");
  } else if (!run) {
    console.log(
      `::notice title=Dashboard e2e burn-in skipped::The change selects ${tests} tests in ${files.length} files, more than ${MAX_TESTS}. The dashboard e2e job still runs them once.`,
    );
  } else {
    console.log(`Burn-in selects ${tests} tests in:\n${files.join("\n")}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
