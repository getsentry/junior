import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Migration lock check.
 *
 * `junior upgrade` runs each pending migration in a transaction against the
 * live database, so a statement that holds a strong lock while it scans or
 * rewrites a table blocks the app until the migration commits. This
 * check rejects those statements on tables that the same migration did not
 * create. `junior upgrade` also bounds each lock wait (see
 * packages/junior/src/db/migrate.ts), so a statement that only
 * needs its lock for an instant, such as ADD COLUMN, passes here. Shipped
 * migrations already ran, so the baseline exempts them.
 */

const BASELINE_PATH = "scripts/migration-locks-baseline.json";
const CONCURRENT_INDEX_MARKER = "-- junior:concurrent-index";
const BOUNDED_BACKFILL_MARKER = "-- junior:bounded-backfill:";
const NAME = String.raw`"?([A-Za-z0-9_]+)"?`;
const TABLE = String.raw`(?:"?public"?\.)?${NAME}`;
const VOLATILE_DEFAULT =
  /\bADD\s+COLUMN\b[^,]*\bDEFAULT\s+\(?\s*(?:gen_random_uuid|uuid_generate_v4|random|clock_timestamp|timeofday)\s*\(/i;

const RULES = {
  "index-without-concurrent-build": `CREATE INDEX on an existing table blocks writes until the migration commits. Put "${CONCURRENT_INDEX_MARKER}" on the line before it and guard the build (see packages/junior/src/db/concurrent-indexes.ts).`,
  "concurrently-in-transaction": `CONCURRENTLY cannot run in the migration transaction. Write a plain CREATE INDEX with "${CONCURRENT_INDEX_MARKER}" before it; junior upgrade builds it concurrently.`,
  "constraint-without-not-valid":
    "ADD CONSTRAINT ... FOREIGN KEY or CHECK on an existing table scans it under lock. Add it NOT VALID, then VALIDATE CONSTRAINT in a later migration.",
  "unique-without-index":
    "ADD UNIQUE or PRIMARY KEY on an existing table builds its index under an exclusive lock. Build a unique index concurrently first, then add the constraint USING INDEX.",
  "column-type-change":
    "ALTER COLUMN ... TYPE on an existing table can rewrite it under an exclusive lock. Add a new column and backfill it instead.",
  "set-not-null":
    "SET NOT NULL on an existing table scans it under an exclusive lock. Add a NOT VALID CHECK (column IS NOT NULL), validate it in a later migration, then set NOT NULL.",
  "volatile-default":
    "ADD COLUMN with a volatile DEFAULT rewrites the table under an exclusive lock. Add the column without a default, then backfill it.",
  "unbounded-backfill": `UPDATE or DELETE on an existing table locks every row it changes until the migration commits, and app writes to those rows wait. Keep it to a small or idle set of rows, and say why on the line before it: "${BOUNDED_BACKFILL_MARKER} <reason>".`,
};

function withoutLineComment(line) {
  return line.replace(/--.*$/, "");
}

function createdTables(sql) {
  const tables = new Set();
  const pattern = new RegExp(
    String.raw`\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${TABLE}`,
    "gi",
  );
  for (const match of sql.matchAll(pattern)) {
    tables.add(match[1].toLowerCase());
  }
  return tables;
}

function indexViolations(lines, newTables) {
  const violations = [];
  const indexPattern = new RegExp(
    String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[^;]*?\bON\s+(?:ONLY\s+)?${TABLE}`,
    "i",
  );
  let previousLine = "";
  for (const line of lines) {
    const code = withoutLineComment(line);
    if (
      /\b(?:(?:CREATE\s+(?:UNIQUE\s+)?|DROP\s+)INDEX|REINDEX\b[^;]*?)\s+CONCURRENTLY\b/i.test(
        code,
      )
    ) {
      violations.push("concurrently-in-transaction");
    } else if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(code)) {
      const table = indexPattern.exec(code)?.[1]?.toLowerCase();
      const isNewTable = table !== undefined && newTables.has(table);
      if (!isNewTable && previousLine !== CONCURRENT_INDEX_MARKER) {
        violations.push("index-without-concurrent-build");
      }
    }
    if (line.trim()) {
      previousLine = line.trim();
    }
  }
  return violations;
}

function backfillViolations(lines, newTables) {
  const violations = [];
  const backfillPattern = new RegExp(
    String.raw`^\s*(?:UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?${TABLE}`,
    "i",
  );
  let previousLine = "";
  for (const line of lines) {
    const table = backfillPattern.exec(line)?.[1]?.toLowerCase();
    if (
      table !== undefined &&
      !newTables.has(table) &&
      !(
        previousLine.startsWith(BOUNDED_BACKFILL_MARKER) &&
        previousLine.slice(BOUNDED_BACKFILL_MARKER.length).trim()
      )
    ) {
      violations.push("unbounded-backfill");
    }
    if (line.trim()) {
      previousLine = line.trim();
    }
  }
  return violations;
}

function alterTableViolations(lines, newTables) {
  const violations = [];
  const alterPattern = new RegExp(
    String.raw`^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE}`,
    "i",
  );
  const statements = lines.map(withoutLineComment).join("\n").split(";");
  for (const statement of statements) {
    const table = alterPattern.exec(statement)?.[1]?.toLowerCase();
    if (table === undefined || newTables.has(table)) {
      continue;
    }
    if (
      /\bADD\s+CONSTRAINT\b[\s\S]*\b(?:FOREIGN\s+KEY|CHECK)\b/i.test(
        statement,
      ) &&
      !/\bNOT\s+VALID\b/i.test(statement)
    ) {
      violations.push("constraint-without-not-valid");
    }
    if (
      /\bADD\s+(?:CONSTRAINT\s+\S+\s+)?(?:UNIQUE|PRIMARY\s+KEY)\b/i.test(
        statement,
      ) &&
      !/\bUSING\s+INDEX\b/i.test(statement)
    ) {
      violations.push("unique-without-index");
    }
    if (
      new RegExp(
        String.raw`\bALTER\s+COLUMN\s+${NAME}\s+(?:SET\s+DATA\s+)?TYPE\b`,
        "i",
      ).test(statement)
    ) {
      violations.push("column-type-change");
    }
    if (
      new RegExp(
        String.raw`\bALTER\s+COLUMN\s+${NAME}\s+SET\s+NOT\s+NULL\b`,
        "i",
      ).test(statement)
    ) {
      violations.push("set-not-null");
    }
    if (VOLATILE_DEFAULT.test(statement)) {
      violations.push("volatile-default");
    }
  }
  return violations;
}

/** List the lock rules that one migration's SQL breaks, by rule id. */
export function migrationLockViolations(sql) {
  const lines = sql.replaceAll("--> statement-breakpoint", "\n").split("\n");
  const newTables = createdTables(lines.map(withoutLineComment).join("\n"));
  return [
    ...indexViolations(lines, newTables),
    ...alterTableViolations(lines, newTables),
    ...backfillViolations(lines, newTables),
  ];
}

/**
 * Report lock rule violations in migration files. A baseline file may break
 * rules because it already ran; it must still break at least one.
 */
export function checkMigrationLocks(files, baseline) {
  const errors = [];
  const exempt = new Set(baseline);
  for (const [filePath, sql] of files) {
    const ruleIds = [...new Set(migrationLockViolations(sql))];
    if (exempt.has(filePath)) {
      if (ruleIds.length === 0) {
        errors.push(
          `${filePath}: breaks no lock rule; remove it from ${BASELINE_PATH}`,
        );
      }
      continue;
    }
    for (const ruleId of ruleIds) {
      errors.push(`${filePath}: ${ruleId}: ${RULES[ruleId]}`);
    }
  }
  const filePaths = new Set(files.map(([filePath]) => filePath));
  for (const filePath of exempt) {
    if (!filePaths.has(filePath)) {
      errors.push(
        `${filePath}: file not found; remove it from ${BASELINE_PATH}`,
      );
    }
  }
  return errors;
}

function migrationFiles(root) {
  const packagesDirectory = path.join(root, "packages");
  return fs
    .readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join("packages", entry.name, "migrations"))
    .filter((directory) => fs.existsSync(path.join(root, directory)))
    .flatMap((directory) =>
      fs
        .readdirSync(path.join(root, directory))
        .filter((file) => /^\d{4}_.+\.sql$/.test(file))
        .sort()
        .map((file) => path.join(directory, file)),
    )
    .map((filePath) => [
      filePath,
      fs.readFileSync(path.join(root, filePath), "utf8"),
    ]);
}

function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDirectory, "..");
  const files = migrationFiles(root);
  const baseline = JSON.parse(
    fs.readFileSync(path.join(root, BASELINE_PATH), "utf8"),
  );
  const errors = checkMigrationLocks(files, baseline);
  if (errors.length === 0) {
    console.log(`Migration lock check passed for ${files.length} migrations.`);
    return;
  }
  console.error(["Migration lock check failed:", ...errors].join("\n"));
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
