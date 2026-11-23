import { latestSnapshots } from "./lib/drizzle-snapshots.mjs";
import { githubStateExceptions } from "./github-state-exceptions.mjs";

/**
 * Provider state check. GitHub is the source of truth for GitHub state, and
 * Junior reads it through the plugin cache (`design/github.md`). The latest
 * Drizzle snapshot of each package is the schema that its migrations create.
 *
 * - Every column of the GitHub plugin's tables must be in
 *   `github-state-exceptions.mjs`, with its reason.
 * - In any package, a column with a provider state name, such as `state` or
 *   `title`, on a table that holds provider ids must be in that file too.
 */

const GITHUB_PACKAGE = "junior-github";
const STATE_NAME =
  /^(?:state|title|draft|merged_at|closed_at|assignees|labels|additions|deletions|changed_files|mergeable)$|_count$/;
// A column that holds the id of a provider object, such as a pull request.
const PROVIDER_ID = /(?:^|_)provider_id$/;

function failure(snapshotPath, key) {
  return `${snapshotPath}: ${key} copies GitHub state. Read it from GitHub through the plugin cache (design/github.md). If it is a Junior-owned fact or too expensive to derive, ask the owner to add it to scripts/github-state-exceptions.mjs with the reason.`;
}

/**
 * Report the columns of one package's Drizzle snapshot that may copy
 * provider state and are not in `exceptions`.
 */
export function checkSnapshot(
  packageName,
  snapshotPath,
  snapshot,
  exceptions = githubStateExceptions,
) {
  const errors = [];
  for (const table of Object.values(snapshot.tables ?? {})) {
    const columns = Object.values(table.columns ?? {});
    const holdsProviderIds = columns.some((column) =>
      PROVIDER_ID.test(column.name),
    );
    for (const column of columns) {
      const key = `${table.name}.${column.name}`;
      if (exceptions[key]) continue;
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

/** Check the latest snapshot of every package that has migrations. */
export function run({ root }) {
  return latestSnapshots(root).flatMap(
    ({ packageName, snapshotPath, snapshot }) =>
      checkSnapshot(packageName, snapshotPath, snapshot),
  );
}
