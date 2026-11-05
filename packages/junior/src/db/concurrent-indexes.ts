/**
 * Concurrent index builds for pending Drizzle migrations.
 *
 * Drizzle applies every pending migration in one transaction, so a plain
 * `CREATE INDEX` in a migration blocks writes to its table until the whole
 * batch commits. A migration marks an index statement that must not block
 * writes with `-- junior:concurrent-index` on the line before it. Before the
 * transactional migrate, `junior upgrade` builds each marked index of a
 * pending migration with `CREATE INDEX CONCURRENTLY`. The migration still
 * guards its own build, so it then finds the index and skips the build.
 */
import type { MigrationMeta } from "drizzle-orm/migrator";
import type { JuniorSqlMigrationExecutor } from "./db";

const CONCURRENT_INDEX_MARKER = "-- junior:concurrent-index";
const INDEX_STATEMENT = /^CREATE INDEX "([a-z0-9_]+)" ON "([a-z0-9_]+)" .+;$/;

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
  // A table that a pending migration creates is new and empty, so the
  // transactional migration builds its indexes without a long lock.
  if (!table?.exists) {
    return;
  }
  const expected = await expectedDefinition(executor, index);
  let state = await readIndexState(executor, index.name);
  if (state && !state.usable) {
    // An interrupted concurrent build leaves an index that cannot be used.
    await executor.execute(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
    state = undefined;
  }
  if (!state) {
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
 * Build the marked indexes of pending migrations before the transactional
 * migrate, so that the migrate does not block writes to existing tables.
 * Call it while the migration lock is held.
 */
export async function buildPendingConcurrentIndexes(
  executor: JuniorSqlMigrationExecutor,
  migrations: readonly MigrationMeta[],
  appliedAt: number | undefined,
): Promise<void> {
  const pending = migrations.filter(
    (migration) =>
      appliedAt === undefined || migration.folderMillis > appliedAt,
  );
  for (const index of pending.flatMap(markedIndexes)) {
    await buildConcurrentIndex(executor, index);
  }
}
