import fs from "node:fs";
import path from "node:path";

/**
 * Parity coverage check. Each row of `behaviors.json`, the behaviors of main's
 * Turn engine, needs a parity test that names its id and runs on both
 * engines, or `engineNeutral`, or an entry in `BASELINE`. baseline-growth
 * lets the baseline only shrink, so a row leaves it only with a test.
 */

const BEHAVIORS = "packages/junior/tests/integration/parity/behaviors.json";
const BASELINE = "packages/junior/scripts/parity-uncovered-baseline.json";
const PARITY_TESTS =
  /^packages\/junior\/tests\/integration\/parity\/.+\.test\.ts$/;
const ROW_ID = /^[a-z]+(?:-[a-z]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const QUOTED_ID = /["'`]([a-z]+(?:-[a-z]+)*:[a-z0-9]+(?:-[a-z0-9]+)*)["'`]/g;

/** Return the row ids that one parity test file names in a string literal. */
export function namedRowIds(source) {
  return [...source.matchAll(QUOTED_ID)].map((match) => match[1]);
}

/**
 * Report rows that no parity test covers and that the baseline does not
 * list, baseline entries that are stale, and test references to unknown
 * rows. `references` maps a test path to the row ids it names. A string
 * whose domain no row has, such as "turn:abc", is not a row id.
 */
export function coverageProblems({ rows, uncovered, references }) {
  const problems = [];
  const ids = new Set();
  for (const row of rows) {
    if (!ROW_ID.test(row.id)) {
      problems.push(`${BEHAVIORS}: "${row.id}" is not a <domain>:<slug> id.`);
    }
    if (ids.has(row.id)) {
      problems.push(`${BEHAVIORS}: "${row.id}" is listed twice.`);
    }
    ids.add(row.id);
  }
  const domains = new Set([...ids].map((id) => id.split(":")[0]));
  const covered = new Set();
  for (const [file, named] of references) {
    for (const id of named) {
      if (ids.has(id)) covered.add(id);
      else if (domains.has(id.split(":")[0])) {
        problems.push(`${file}: "${id}" is not a row in ${BEHAVIORS}.`);
      }
    }
  }
  const listed = new Set();
  for (const id of uncovered) {
    if (listed.has(id)) problems.push(`${BASELINE}: "${id}" is listed twice.`);
    listed.add(id);
    if (!ids.has(id)) {
      problems.push(
        `${BASELINE}: "${id}" is not a row. Remove it, so the list shrinks.`,
      );
    }
  }
  for (const row of rows) {
    const exempt = covered.has(row.id) || row.engineNeutral === true;
    if (exempt && listed.has(row.id)) {
      problems.push(
        `${BASELINE}: "${row.id}" is covered. Remove it, so the list shrinks.`,
      );
    }
    if (!exempt && !listed.has(row.id)) {
      problems.push(
        `${BEHAVIORS}: "${row.id}" has no parity test. Add a test in tests/integration/parity that names it and runs on both engines.`,
      );
    }
  }
  return problems;
}

/** Check the behavior list, the baseline, and the parity tests. */
export function run({ root, files }) {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const references = files
    .filter((file) => PARITY_TESTS.test(file))
    .map((file) => [file, namedRowIds(read(file))]);
  return coverageProblems({
    rows: JSON.parse(read(BEHAVIORS)),
    uncovered: JSON.parse(read(BASELINE)),
    references,
  });
}
