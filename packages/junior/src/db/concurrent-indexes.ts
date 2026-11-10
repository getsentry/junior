/**
 * Concurrent index builds for pending Drizzle migrations.
 *
 * Each migration runs in one transaction, so a plain `CREATE INDEX` in a
 * migration blocks writes to its table until the migration commits. A
 * migration marks an index statement that must not block writes with
 * `-- junior:concurrent-index` on the line before it. Just before a pending
 * migration runs, `junior upgrade` builds each of its marked indexes with
 * `CREATE INDEX CONCURRENTLY`. The migration still guards its own build, so
 * it then finds the index and skips the build.
 */
import type { MigrationMeta } from "drizzle-orm/migrator";
import type { JuniorSqlMigrationExecutor } from "./db";
import { isPostgresErrorCode } from "./postgres-error";

const CONCURRENT_INDEX_MARKER = "-- junior:concurrent-index";
const INDEX_STATEMENT = /^CREATE INDEX "([a-z0-9_]+)" ON "([a-z0-9_]+)" .+;$/;
// Postgres `undefined_column`.
const UNDEFINED_COLUMN = "42703";

interface ConcurrentIndex {
  name: string;
  statement: string;
  table: string;
}

interface IndexState {
  definition: string;
  usable: boolean;
}

function markedIndexes(migration: MigrationMeta): ConcurrentIndex[] {
  const lines = migration.sql
    .join("")
    .split("\n")
    .map((line) => line.trim());
  const indexes: ConcurrentIndex[] = [];
  for (const [index, line] of lines.entries()) {
    if (line !== CONCURRENT_INDEX_MARKER) {
      continue;
    }
    const statement = lines[index + 1] ?? "";
    const match = INDEX_STATEMENT.exec(statement);
    if (!match?.[1] || !match[2]) {
      throw new Error(
        `Migration ${migration.folderMillis}: the line after "${CONCURRENT_INDEX_MARKER}" must be one CREATE INDEX statement on one line.`,
      );
    }
    indexes.push({ name: match[1], statement, table: match[2] });
  }
  return indexes;
}

/** Remove the schema name so indexes on same-name tables compare equal. */
function withoutSchema(definition: string): string {
  return definition.replace(/ ON [^ ]+\./, " ON ");
}

async function readIndexState(
  executor: JuniorSqlMigrationExecutor,
  name: string,
): Promise<IndexState | undefined> {
  const [row] = await executor.query<IndexState>(
    `SELECT pg_get_indexdef(indexrelid) AS definition,
            indisvalid AND indisready AS usable
     FROM pg_index
     WHERE indexrelid = to_regclass($1)`,
    [name],
  );
  return row;
}

async function expectedDefinition(
  executor: JuniorSqlMigrationExecutor,
  index: ConcurrentIndex,
): Promise<string> {
  return await executor.transaction(async () => {
    // The temporary table hides the real table of the same name, so the
    // migration statement builds on the empty copy, and Postgres prints the
    // definition in the same form as for the real index.
    await executor.execute(
      `CREATE TEMPORARY TABLE "${index.table}" (LIKE "${index.table}") ON COMMIT DROP`,
    );
    await executor.execute(index.statement);
    const [row] = await executor.query<{ definition: string }>(
      `SELECT pg_get_indexdef(format('pg_temp.%I', $1::text)::regclass) AS definition`,
      [index.name],
    );
    if (!row) {
      throw new Error(`Index ${index.name} was not built on the empty copy.`);
    }
    return withoutSchema(row.definition);
  });
}

async function buildConcurrentIndex(
  executor: JuniorSqlMigrationExecutor,
  index: ConcurrentIndex,
): Promise<void> {
  const [table] = await executor.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS "exists"`,
    [index.table],
  );
  // A table that this migration creates is new and empty, so the
  // transactional migration builds its indexes without a long lock.
  if (!table?.exists) {
    return;
  }
  let expected: string;
  try {
    expected = await expectedDefinition(executor, index);
  } catch (error) {
    // Earlier migrations have committed, so this migration adds a column
    // that the index uses. Its ADD COLUMN already blocks writes to the table
    // until it commits, so a concurrent build gives no benefit. The
    // migration's own build adds only a scan of the existing rows to that
    // block. If the column is missing for another reason, that build fails
    // with the same error.
    if (isPostgresErrorCode(error, UNDEFINED_COLUMN)) {
      return;
    }
    throw error;
  }
  let state = await readIndexState(executor, index.name);
  if (state && !state.usable) {
    // An interrupted concurrent build leaves an index that cannot be used.
    await executor.execute(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
    state = undefined;
  }
  if (!state) {
    const [heap] = await executor.query<{ empty: boolean }>(
      `SELECT pg_relation_size(to_regclass($1)) = 0 AS empty`,
      [index.table],
    );
    // A table that never stored a row, such as one that an earlier migration
    // of a fresh install created, gets its index at once in the migration.
    if (heap?.empty) {
      return;
    }
    await executor.execute(
      index.statement.replace(/^CREATE INDEX /, "CREATE INDEX CONCURRENTLY "),
    );
    state = await readIndexState(executor, index.name);
  }
  if (!state?.usable || withoutSchema(state.definition) !== expected) {
    throw new Error(
      `Index ${index.name} does not match its migration. Expected "${expected}", found "${state?.definition ?? "no index"}". Drop the index, then run junior upgrade again.`,
    );
  }
}

/**
 * Build the marked indexes of one pending migration before its transaction,
 * so that the migration does not block writes to existing tables. Call it
 * while the migration lock is held, after earlier migrations have committed.
 */
export async function buildConcurrentIndexes(
  executor: JuniorSqlMigrationExecutor,
  migration: MigrationMeta,
): Promise<void> {
  for (const index of markedIndexes(migration)) {
    await buildConcurrentIndex(executor, index);
  }
}
