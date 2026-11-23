import fs from "node:fs";
import path from "node:path";
import { latestSnapshots } from "./lib/drizzle-snapshots.mjs";

/**
 * Provider state check. GitHub is the source of truth for GitHub state, and
 * Junior reads it through the plugin cache (`design/github.md`). The latest
 * Drizzle snapshot of each package is the schema that its migrations create.
 *
 * - Every column of the GitHub plugin's tables must be listed, with its
 *   reason.
 * - In any package, a column with a provider state name, such as `state` or
 *   `title`, on a table that holds provider ids must be listed too.
 *
 * Each file maps a table to a reason for the whole table, or to a reason for
 * each column.
 *
 * - `EXCEPTIONS` holds the values that Junior keeps. A reason says the value
 *   is Junior-owned (a fact that Junior decides or records, or a key for one)
 *   or too expensive to derive (a value that a read needs for many objects
 *   at once, which GitHub cannot give at that cost). It grows only through
 *   a PR that the owner reviews.
 * - `BASELINE` holds the copies of GitHub state that a cleanup removes. It
 *   may only shrink (`baseline-growth:check`). Delete it, and the code that
 *   reads it, with its last entry.
 */

const EXCEPTIONS = "scripts/github-state-exceptions.json";
const BASELINE = "scripts/github-state-baseline.json";

const GITHUB_PACKAGE = "junior-github";
const STATE_NAME =
  /^(?:state|title|draft|merged_at|closed_at|assignees|labels|additions|deletions|changed_files|mergeable)$|_count$/;
// A column that holds the id of a provider object, such as a pull request.
const PROVIDER_ID = /(?:^|_)provider_id$/;

function failure(snapshotPath, key) {
  return `${snapshotPath}: ${key} copies GitHub state. Read it from GitHub through the plugin cache (design/github.md). If it is a Junior-owned fact or too expensive to derive, ask the owner to add it to ${EXCEPTIONS} with the reason.`;
}

/**
 * Report the columns of one package's Drizzle snapshot that may copy
 * provider state and are not in `listed`, the tables of both files.
 */
export function checkSnapshot(packageName, snapshotPath, snapshot, listed) {
  const errors = [];
  for (const table of Object.values(snapshot.tables ?? {})) {
    const columns = Object.values(table.columns ?? {});
    const excepted = listed[table.name] ?? {};
    const holdsProviderIds = columns.some((column) =>
      PROVIDER_ID.test(column.name),
    );
    for (const column of columns) {
      const key = `${table.name}.${column.name}`;
      if (typeof excepted === "string" || excepted[column.name]) continue;
      if (
        packageName === GITHUB_PACKAGE ||
        (holdsProviderIds && STATE_NAME.test(column.name))
      ) {
        errors.push(failure(snapshotPath, key));
      }
    }
  }
  return errors;
}

function readTables(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8")).tables;
}

/**
 * Join the tables of two files. A table reason covers the whole table, so it
 * wins over column reasons.
 */
export function joinTables(first, second) {
  const tables = { ...first };
  for (const [name, reasons] of Object.entries(second)) {
    const current = tables[name];
    if (typeof current === "string") continue;
    tables[name] =
      typeof reasons === "string" ? reasons : { ...current, ...reasons };
  }
  return tables;
}

/** Check the latest snapshot of every package that has migrations. */
export function run({ root }) {
  const listed = joinTables(
    readTables(root, EXCEPTIONS),
    readTables(root, BASELINE),
  );
  return latestSnapshots(root).flatMap(
    ({ packageName, snapshotPath, snapshot }) =>
      checkSnapshot(packageName, snapshotPath, snapshot, listed),
  );
}
