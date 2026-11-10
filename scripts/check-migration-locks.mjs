import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule, parse, parsePlPgSQL } from "libpg-query";
import pLimit from "p-limit";

/**
 * Migration lock check.
 *
 * `junior upgrade` runs each pending migration in a transaction against the
 * live database, so a statement that holds a strong lock while it scans or
 * rewrites a table blocks the app until the migration commits. This
 * check parses each migration with the Postgres parser, including the SQL in
 * DO blocks, and rejects those statements on tables that the same migration
 * did not create. `junior upgrade` also bounds each lock wait (see
 * packages/junior/src/db/migrate.ts), so a statement that only
 * needs its lock for an instant, such as ADD COLUMN, passes here. Shipped
 * migrations already ran, so the baseline exempts them.
 */

const BASELINE_PATH = "scripts/migration-locks-baseline.json";
const CONCURRENT_INDEX_MARKER = "-- junior:concurrent-index";
const BOUNDED_BACKFILL_MARKER = "-- junior:bounded-backfill:";
// The one-line statement shape that packages/junior/src/db/concurrent-indexes.ts
// can build concurrently.
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const CONCURRENT_INDEX_STATEMENT =
  /^CREATE INDEX "[a-z0-9_]+" ON "[a-z0-9_]+" .+;$/;
const VOLATILE_FUNCTIONS = new Set([
  "gen_random_uuid",
  "uuid_generate_v4",
  "random",
  "clock_timestamp",
  "timeofday",
]);
const FILE_CONCURRENCY = 8;

const RULES = {
  "index-without-concurrent-build": `CREATE INDEX on an existing table blocks writes until the migration commits. Put "${CONCURRENT_INDEX_MARKER}" on the line before it and guard the build (see packages/junior/src/db/concurrent-indexes.ts).`,
  "unsupported-concurrent-index": `junior upgrade builds only a one-line plain CREATE INDEX "name" ON "table" ... concurrently, so the line after "${CONCURRENT_INDEX_MARKER}" must have that shape.`,
  "concurrently-in-transaction": `CONCURRENTLY cannot run in the migration transaction. Write a plain CREATE INDEX with "${CONCURRENT_INDEX_MARKER}" before it; junior upgrade builds it concurrently.`,
  "constraint-without-not-valid":
    "ADD CONSTRAINT ... FOREIGN KEY or CHECK on an existing table scans it under lock. Add it NOT VALID, then VALIDATE CONSTRAINT in a later migration.",
  "unique-without-index": `ADD UNIQUE or PRIMARY KEY on an existing table builds its index under an exclusive lock. "${CONCURRENT_INDEX_MARKER}" cannot build a unique index yet, so this needs a change to junior upgrade first.`,
  "column-type-change":
    "ALTER COLUMN ... TYPE on an existing table can rewrite it under an exclusive lock. Add a new column and backfill it instead.",
  "set-not-null":
    "SET NOT NULL on an existing table scans it under an exclusive lock. Add a NOT VALID CHECK (column IS NOT NULL), validate it in a later migration, then set NOT NULL.",
  "volatile-default":
    "ADD COLUMN with a volatile DEFAULT rewrites the table under an exclusive lock. Add the column without a default, then backfill it.",
  "unbounded-backfill": `UPDATE or DELETE on an existing table locks every row it changes until the migration commits, and app writes to those rows wait. Keep it to a small or idle set of rows, and say why on the line before it: "${BOUNDED_BACKFILL_MARKER} <reason>".`,
};

const loaded = loadModule();

/** Line number (1-based) of a byte offset in the UTF-8 source. */
function lineAt(bytes, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (bytes[index] === 0x0a) {
      line += 1;
    }
  }
  return line;
}

function collectExecSql(node, found) {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectExecSql(item, found);
    }
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  const execSql = node.PLpgSQL_stmt_execsql;
  if (execSql !== undefined) {
    found.push({
      query: execSql.sqlstmt.PLpgSQL_expr.query,
      lineno: execSql.lineno,
    });
  }
  for (const value of Object.values(node)) {
    collectExecSql(value, found);
  }
}

/**
 * Parse a migration into its statements with their source lines, including
 * the SQL statements inside DO blocks.
 */
async function parsedStatements(sql) {
  await loaded;
  const bytes = Buffer.from(sql);
  const statements = [];
  for (const raw of (await parse(sql)).stmts) {
    const start = raw.stmt_location ?? 0;
    const line = lineAt(bytes, start);
    if (raw.stmt.DoStmt === undefined) {
      statements.push({ node: raw.stmt, line });
      continue;
    }
    const end = raw.stmt_len ? start + raw.stmt_len : bytes.length;
    const text = bytes.subarray(start, end).toString();
    // PL/pgSQL line 1 is the line that opens the body with $$, $tag$, or a quote.
    const bodyLine =
      line + text.slice(0, text.search(/\$\w*\$|'/)).split("\n").length - 1;
    const embedded = [];
    collectExecSql(await parsePlPgSQL(`${text};`), embedded);
    for (const { query, lineno } of embedded) {
      for (const inner of (await parse(query)).stmts) {
        statements.push({ node: inner.stmt, line: bodyLine + lineno - 1 });
      }
    }
  }
  return statements;
}

function constraintViolation(constraint) {
  if (
    (constraint.contype === "CONSTR_FOREIGN" ||
      constraint.contype === "CONSTR_CHECK") &&
    !constraint.skip_validation
  ) {
    return "constraint-without-not-valid";
  }
  if (
    (constraint.contype === "CONSTR_UNIQUE" ||
      constraint.contype === "CONSTR_PRIMARY") &&
    constraint.indexname === undefined
  ) {
    return "unique-without-index";
  }
  if (
    constraint.contype === "CONSTR_DEFAULT" &&
    VOLATILE_FUNCTIONS.has(
      constraint.raw_expr?.FuncCall?.funcname?.at(-1)?.String?.sval,
    )
  ) {
    return "volatile-default";
  }
  return undefined;
}

function alterTableViolations(command) {
  switch (command.subtype) {
    case "AT_AddConstraint":
      return [constraintViolation(command.def.Constraint)];
    case "AT_AddColumn":
      return (command.def.ColumnDef.constraints ?? []).map((constraint) =>
        constraintViolation(constraint.Constraint),
      );
    case "AT_AlterColumnType":
      return ["column-type-change"];
    case "AT_SetNotNull":
      return ["set-not-null"];
    default:
      return [];
  }
}

function isConcurrent(node) {
  return Boolean(
    node.IndexStmt?.concurrent ||
    node.DropStmt?.concurrent ||
    node.ReindexStmt?.params?.some(
      (param) => param.DefElem.defname === "concurrently",
    ),
  );
}

/** Return the lock rule ids that a migration's SQL breaks. */
export async function migrationLockViolations(sql) {
  const lines = sql.split("\n");
  const statements = await parsedStatements(sql);
  const lineBefore = (line) =>
    lines
      .slice(0, line - 1)
      .findLast((text) => text.trim() !== "")
      ?.trim() ?? "";
  // IF NOT EXISTS can keep an existing table with all its rows.
  const newTables = new Set(
    statements
      .map(({ node }) => node.CreateStmt)
      .filter((create) => create !== undefined && !create.if_not_exists)
      .map((create) => create.relation.relname),
  );
  const isExisting = (relation) =>
    relation !== undefined && !newTables.has(relation.relname);
  const violations = [];
  for (const { node, line } of statements) {
    if (isConcurrent(node)) {
      violations.push("concurrently-in-transaction");
      continue;
    }
    if (node.IndexStmt && isExisting(node.IndexStmt.relation)) {
      if (lineBefore(line) !== CONCURRENT_INDEX_MARKER) {
        violations.push("index-without-concurrent-build");
      } else if (
        !CONCURRENT_INDEX_STATEMENT.test(
          // Drizzle removes the breakpoint before junior upgrade reads the line.
          lines[line - 1].replace(STATEMENT_BREAKPOINT, "").trim(),
        )
      ) {
        violations.push("unsupported-concurrent-index");
      }
    }
    if (node.AlterTableStmt && isExisting(node.AlterTableStmt.relation)) {
      for (const command of node.AlterTableStmt.cmds) {
        violations.push(...alterTableViolations(command.AlterTableCmd));
      }
    }
    const backfill = node.UpdateStmt ?? node.DeleteStmt;
    const before = lineBefore(line);
    const hasBackfillReason =
      before.startsWith(BOUNDED_BACKFILL_MARKER) &&
      before.slice(BOUNDED_BACKFILL_MARKER.length).trim() !== "";
    if (isExisting(backfill?.relation) && !hasBackfillReason) {
      violations.push("unbounded-backfill");
    }
  }
  return [...new Set(violations.filter(Boolean))];
}

/**
 * Report lock rule violations in migration files. A baseline file may break
 * rules because it already ran; it must still break at least one.
 */
export async function checkMigrationLocks(files, baseline) {
  const limit = pLimit(FILE_CONCURRENCY);
  const results = await Promise.all(
    files.map(([filePath, sql]) =>
      limit(async () => {
        try {
          return [filePath, await migrationLockViolations(sql)];
        } catch (error) {
          throw new Error(`${filePath}: cannot parse migration`, {
            cause: error,
          });
        }
      }),
    ),
  );
  const errors = [];
  const exempt = new Set(baseline);
  for (const [filePath, ruleIds] of results) {
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

async function migrationFiles(root) {
  const packagesDirectory = path.join(root, "packages");
  const packages = await fs.readdir(packagesDirectory, { withFileTypes: true });
  const directories = packages
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join("packages", entry.name, "migrations"));
  const filePaths = (
    await Promise.all(
      directories.map(async (directory) => {
        const names = await fs
          .readdir(path.join(root, directory))
          .catch((error) => {
            if (error.code === "ENOENT") {
              return [];
            }
            throw error;
          });
        return names
          .filter((file) => /^\d{4}_.+\.sql$/.test(file))
          .sort()
          .map((file) => path.join(directory, file));
      }),
    )
  ).flat();
  const limit = pLimit(FILE_CONCURRENCY);
  return Promise.all(
    filePaths.map((filePath) =>
      limit(async () => [
        filePath,
        await fs.readFile(path.join(root, filePath), "utf8"),
      ]),
    ),
  );
}

async function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDirectory, "..");
  const [files, baselineText] = await Promise.all([
    migrationFiles(root),
    fs.readFile(path.join(root, BASELINE_PATH), "utf8"),
  ]);
  const errors = await checkMigrationLocks(files, JSON.parse(baselineText));
  if (errors.length === 0) {
    console.log(`Migration lock check passed for ${files.length} migrations.`);
    return;
  }
  console.error(["Migration lock check failed:", ...errors].join("\n"));
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
