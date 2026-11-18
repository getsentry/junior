import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule, parse, parsePlPgSQL } from "libpg-query";

/**
 * Migration lock checks that squawk (`.squawk.toml`) cannot do.
 *
 * `junior upgrade` runs each pending migration in a transaction against the
 * live database. Squawk checks the statements that lock a whole table, but it
 * has no rule for row-locking backfills, and it does not read SQL inside DO
 * blocks (sbdchd/squawk#411). This check parses each migration with the
 * Postgres parser, including the SQL in DO blocks. Shipped migrations already
 * ran, so the baseline exempts them.
 */

const BASELINE_PATH = "scripts/migration-locks-baseline.json";
const BOUNDED_BACKFILL_MARKER = "-- junior:bounded-backfill:";
const RULES = {
  "unbounded-backfill": `UPDATE or DELETE on an existing table locks every row it changes until the migration commits, and app writes to those rows wait. Keep it to a small or idle set of rows, and say why on the line before it: "${BOUNDED_BACKFILL_MARKER} <reason>".`,
  "ddl-in-do-block":
    "Squawk cannot check SQL inside a DO block. Put the statement at the top level of the migration.",
};
// DO block statements that squawk has no lock rule for.
const DO_BLOCK_STATEMENTS = new Set([
  "SelectStmt",
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
]);

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
      statements.push({ node: raw.stmt, line, inDoBlock: false });
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
        statements.push({
          node: inner.stmt,
          line: bodyLine + lineno - 1,
          inDoBlock: true,
        });
      }
    }
  }
  return statements;
}

/** Return the lock rule ids that a migration's SQL breaks. */
export async function migrationLockViolations(sql) {
  const lines = sql.split("\n");
  const statements = await parsedStatements(sql);
  // IF NOT EXISTS can keep an existing table with all its rows.
  const newTables = new Set(
    statements
      .map(({ node }) => node.CreateStmt)
      .filter((create) => create !== undefined && !create.if_not_exists)
      .map((create) => create.relation.relname),
  );
  const violations = new Set();
  for (const { node, line, inDoBlock } of statements) {
    if (inDoBlock && !DO_BLOCK_STATEMENTS.has(Object.keys(node)[0])) {
      violations.add("ddl-in-do-block");
    }
    const relation = (node.UpdateStmt ?? node.DeleteStmt)?.relation;
    if (relation === undefined || newTables.has(relation.relname)) {
      continue;
    }
    const before =
      lines
        .slice(0, line - 1)
        .findLast((text) => text.trim() !== "")
        ?.trim() ?? "";
    if (
      !before.startsWith(BOUNDED_BACKFILL_MARKER) ||
      before.slice(BOUNDED_BACKFILL_MARKER.length).trim() === ""
    ) {
      violations.add("unbounded-backfill");
    }
  }
  return [...violations];
}

/**
 * Report lock rule violations in migration files. A baseline file may break
 * rules because it already ran; it must still break at least one.
 */
export async function checkMigrationLocks(files, baseline) {
  const errors = [];
  const exempt = new Set(baseline);
  for (const [filePath, sql] of files) {
    let ruleIds;
    try {
      ruleIds = await migrationLockViolations(sql);
    } catch (error) {
      throw new Error(`${filePath}: cannot parse migration`, { cause: error });
    }
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
  const packages = await fs.readdir(path.join(root, "packages"), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of packages.filter((item) => item.isDirectory())) {
    const directory = path.join("packages", entry.name, "migrations");
    const names = await fs
      .readdir(path.join(root, directory))
      .catch((error) => {
        if (error.code === "ENOENT") {
          return [];
        }
        throw error;
      });
    for (const name of names
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort()) {
      const filePath = path.join(directory, name);
      files.push([
        filePath,
        await fs.readFile(path.join(root, filePath), "utf8"),
      ]);
    }
  }
  return files;
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
