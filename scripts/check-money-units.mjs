import fs from "node:fs";
import path from "node:path";

/**
 * Money unit check. Postgres stores every money value as whole micro-USD:
 * a `bigint` column, or an integer metric value, named `*_micro_usd`. Integer
 * sums are exact, so no read needs float cleanup. Code converts USD to
 * micro-USD and back only in `MONEY_HELPER`.
 *
 * - Columns: the latest Drizzle snapshot of each package is the schema that
 *   its migrations create. A column with a money word in its name must be a
 *   `bigint` named `*_micro_usd`.
 * - Stored names: a snake_case string in production source names a column,
 *   metric, or counter. One with a money word must end in `_micro_usd`.
 * - Units: a money scale, such as `UNITS_PER_USD` or `* 1e6`, must not appear
 *   outside `MONEY_HELPER`.
 */

const MONEY_HELPER = "packages/junior/src/db/micro-usd.ts";
const MONEY_WORD =
  /(?:^|_)(?:amounts?|budgets?|cents?|costs?|dollars?|fees?|prices?|savings?|spend|spent|usd)(?:_|$)/;
const MICRO_USD = /_micro_usd$/;
const SNAKE_STRING = /["'`]([a-z0-9]+(?:_[a-z0-9]+)+)["'`]/g;
const MONEY_SCALES = [
  /\b[A-Z0-9_]*PER_(?:USD|DOLLARS?)\b/,
  /\*\s*(?:1e6|1e-6|1_000_000|1000000)(?![\d_])/,
  /(?<![\d_.])(?:1e6|1e-6|1_000_000|1000000)\s*\*/,
];
// The dashboard has no database access.
const EXCLUDED_PACKAGES = new Set([
  "junior-dashboard",
  "junior-evals",
  "junior-testing",
]);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\/(?:__tests__|fixtures?)\//;

/**
 * Columns that hold money in another unit, with the reason. Remove an entry
 * when its column is dropped.
 */
export const COLUMN_ALLOWLIST = {
  "junior_conversation_briefs.cost_usd":
    "Old USD cost that the runtime before micro-USD writes during its rollout. Drop it in the next release.",
};

/** Snake_case strings that contain a money word but name no stored money. */
export const NAME_ALLOWLIST = {
  // A cache warming decision reason, not an amount.
  no_savings: ["packages/junior/src/chat/cache-warming/model.ts"],
  // An embedding backfill stop reason, not an amount.
  budget_exceeded: [
    "packages/junior/src/chat/conversations/embedding-backfill.ts",
  ],
  // The Drizzle name of the old Brief cost column in COLUMN_ALLOWLIST.
  cost_usd: ["packages/junior/src/db/schema/conversation-briefs.ts"],
  // A Postgres planner setting, not an amount.
  jit_above_cost: ["packages/junior/src/cli/upgrade.ts"],
};

/**
 * Report money columns of one Drizzle snapshot that are not `bigint`
 * `*_micro_usd` columns.
 */
export function checkSnapshotColumns(snapshotPath, snapshot) {
  const errors = [];
  for (const table of Object.values(snapshot.tables ?? {})) {
    for (const column of Object.values(table.columns ?? {})) {
      const key = `${table.name}.${column.name}`;
      if (!MONEY_WORD.test(column.name) || COLUMN_ALLOWLIST[key]) continue;
      if (!MICRO_USD.test(column.name) || column.type !== "bigint") {
        errors.push(
          `${snapshotPath}: ${key} is ${column.type}. Store money as a bigint column named *_micro_usd.`,
        );
      }
    }
  }
  return errors;
}

/**
 * Report money names that are not `*_micro_usd`, and money scales, in one
 * production source file.
 */
export function checkSource(filePath, text) {
  if (filePath === MONEY_HELPER) return [];
  const errors = [];
  for (const [index, line] of text.split("\n").entries()) {
    const at = `${filePath}:${index + 1}`;
    for (const [, name] of line.matchAll(SNAKE_STRING)) {
      if (
        MONEY_WORD.test(name) &&
        !MICRO_USD.test(name) &&
        !NAME_ALLOWLIST[name]?.includes(filePath)
      ) {
        errors.push(
          `${at}: "${name}" names money. Store it in micro-USD and name it *_micro_usd.`,
        );
      }
    }
    if (MONEY_SCALES.some((scale) => scale.test(line))) {
      errors.push(
        `${at}: money scale outside ${MONEY_HELPER}. Convert USD with its helpers.`,
      );
    }
  }
  return errors;
}

/** Check every package's latest snapshot and production source. */
export function run({ root, files }) {
  const errors = [];
  const packages = fs
    .readdirSync(path.join(root, "packages"))
    .filter((name) => !EXCLUDED_PACKAGES.has(name))
    .sort();
  for (const name of packages) {
    const meta = path.join("packages", name, "migrations", "meta");
    const journalPath = path.join(root, meta, "_journal.json");
    if (fs.existsSync(journalPath)) {
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      const last = journal.entries.at(-1);
      if (last) {
        const snapshotPath = path.join(
          meta,
          `${String(last.idx).padStart(4, "0")}_snapshot.json`,
        );
        errors.push(
          ...checkSnapshotColumns(
            snapshotPath,
            JSON.parse(fs.readFileSync(path.join(root, snapshotPath), "utf8")),
          ),
        );
      }
    }
    const sourceFiles = files.filter(
      (filePath) =>
        filePath.startsWith(`packages/${name}/src/`) &&
        SOURCE_FILE.test(filePath) &&
        !TEST_FILE.test(filePath),
    );
    for (const filePath of sourceFiles) {
      errors.push(
        ...checkSource(
          filePath,
          fs.readFileSync(path.join(root, filePath), "utf8"),
        ),
      );
    }
  }
  return errors;
}
