import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { createPostgresJuniorSqlExecutor } from "@/db/postgres";
import {
  createEmptyJuniorPostgresFixture,
  hasJuniorPostgresTestDatabase,
} from "../fixtures/sql";

const PLUGIN_NAME = "concurrent-index-test";
const INDEX_NAME = "concurrent_index_items_group_idx";
const CREATE_ITEMS = `CREATE TABLE "concurrent_index_items" ("id" integer PRIMARY KEY, "group_id" integer NOT NULL);`;
// The same guarded shape that core index migrations use.
const CREATE_GROUP_INDEX = `DO $$
BEGIN
  IF to_regclass('${INDEX_NAME}') IS NULL THEN
    -- junior:concurrent-index
    CREATE INDEX "${INDEX_NAME}" ON "concurrent_index_items" USING btree ("group_id");
  END IF;
END $$;`;

async function writeMigrations(
  dir: string,
  migrations: readonly { sql: string; tag: string }[],
): Promise<void> {
  await mkdir(join(dir, "meta"), { recursive: true });
  for (const migration of migrations) {
    await writeFile(join(dir, `${migration.tag}.sql`), migration.sql);
  }
  await writeFile(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({
      dialect: "postgresql",
      entries: migrations.map((migration, idx) => ({
        breakpoints: true,
        idx,
        tag: migration.tag,
        version: "7",
        when: (idx + 1) * 1000,
      })),
      version: "7",
    }),
  );
}

/** Apply the items table, then add the index migration as a later release would. */
async function createItemsWithPendingIndex(
  sql: Parameters<typeof migratePluginSchemas>[0],
): Promise<{ dir: string; migrate(): Promise<unknown> }> {
  const dir = await mkdtemp(join(tmpdir(), "junior-concurrent-index-"));
  const roots = [{ dir, pluginName: PLUGIN_NAME }];
  await writeMigrations(dir, [{ sql: CREATE_ITEMS, tag: "0000_items" }]);
  await migratePluginSchemas(sql, roots);
  await writeMigrations(dir, [
    { sql: CREATE_ITEMS, tag: "0000_items" },
    { sql: CREATE_GROUP_INDEX, tag: "0001_items_group_index" },
  ]);
  return { dir, migrate: () => migratePluginSchemas(sql, roots) };
}

describe.skipIf(!hasJuniorPostgresTestDatabase())(
  "concurrent index migrations",
  () => {
    it("builds a pending index without blocking writes to its table", async () => {
      const fixture = await createEmptyJuniorPostgresFixture();
      const writer = createPostgresJuniorSqlExecutor({
        connectionString: fixture.connectionString,
        statementTimeoutMs: 5_000,
      });
      const pending = await createItemsWithPendingIndex(fixture.sql);
      let finishWrite!: () => void;
      const writeFinished = new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
      let writeStarted!: () => void;
      const writeOpen = new Promise<void>((resolve) => {
        writeStarted = resolve;
      });

      try {
        // A write transaction that stays open makes a plain CREATE INDEX wait
        // with its write-blocking lock, so later writes would wait behind it.
        const openWrite = writer.transaction(async () => {
          await writer.execute(
            `INSERT INTO "concurrent_index_items" VALUES (1, 1)`,
          );
          writeStarted();
          await writeFinished;
        });
        await writeOpen;
        const migration = pending.migrate();

        await vi.waitFor(
          async () => {
            const [build] = await writer.query<{ count: number }>(
              `SELECT count(*)::integer AS count
               FROM pg_stat_activity
               WHERE query LIKE 'CREATE INDEX CONCURRENTLY%'
                 AND wait_event_type = 'Lock'`,
            );
            expect(build?.count).toBe(1);
          },
          { timeout: 5_000 },
        );
        await expect(
          writer.execute(`INSERT INTO "concurrent_index_items" VALUES (2, 1)`),
        ).resolves.toBeUndefined();

        finishWrite();
        await openWrite;
        await expect(migration).resolves.toMatchObject({ migrated: 1 });
        const [index] = await writer.query<{ usable: boolean }>(
          `SELECT indisvalid AND indisready AS usable
           FROM pg_index
           WHERE indexrelid = to_regclass($1)`,
          [INDEX_NAME],
        );
        expect(index?.usable).toBe(true);
      } finally {
        finishWrite();
        await writer.close();
        await fixture.close();
        await rm(pending.dir, { force: true, recursive: true });
      }
    });

    it("rebuilds an interrupted build and rejects an index that differs", async () => {
      const fixture = await createEmptyJuniorPostgresFixture();
      const pending = await createItemsWithPendingIndex(fixture.sql);

      try {
        await fixture.sql.execute(
          `CREATE INDEX "${INDEX_NAME}" ON "concurrent_index_items" ("id")`,
        );
        await expect(pending.migrate()).rejects.toThrow(
          `Index ${INDEX_NAME} does not match its migration`,
        );
        await fixture.sql.execute(`DROP INDEX "${INDEX_NAME}"`);

        // A failed concurrent build leaves an invalid index with the name.
        await fixture.sql.execute(
          `INSERT INTO "concurrent_index_items" VALUES (1, 1), (2, 1)`,
        );
        await expect(
          fixture.sql.execute(
            `CREATE UNIQUE INDEX CONCURRENTLY "${INDEX_NAME}" ON "concurrent_index_items" ("group_id")`,
          ),
        ).rejects.toMatchObject({ code: "23505" });

        await expect(pending.migrate()).resolves.toMatchObject({
          migrated: 1,
        });
        const [index] = await fixture.sql.query<{
          definition: string;
          usable: boolean;
        }>(
          `SELECT pg_get_indexdef(indexrelid) AS definition,
                  indisvalid AND indisready AS usable
           FROM pg_index
           WHERE indexrelid = to_regclass($1)`,
          [INDEX_NAME],
        );
        expect(index).toEqual({
          definition: `CREATE INDEX ${INDEX_NAME} ON public.concurrent_index_items USING btree (group_id)`,
          usable: true,
        });
      } finally {
        await fixture.close();
        await rm(pending.dir, { force: true, recursive: true });
      }
    });
  },
);
