/**
 * The memory database for tests. One PGlite start takes most of the setup
 * time, so this module starts and migrates one database when a test file
 * loads it. Each test then loads its own copy of that database.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalPgliteFixture,
  pgliteBtreeGinExtension,
  pgliteVectorExtension,
  type LocalPgliteFixture,
} from "@sentry/junior-testing/pglite";
import * as memorySqlSchema from "../src/db/schema";
import type { MemoryDb } from "../src/store";

export type MemoryFixture = LocalPgliteFixture<MemoryDb>;

const extensions = {
  btree_gin: pgliteBtreeGinExtension,
  vector: pgliteVectorExtension,
};

async function dumpMigratedDatabase() {
  const fixture = await createLocalPgliteFixture<MemoryDb>(memorySqlSchema, {
    extensions,
  });
  try {
    const migrationsDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../migrations",
    );
    const migrations = (await readdir(migrationsDir))
      .filter((filename) => filename.endsWith(".sql"))
      .sort();
    for (const filename of migrations) {
      await fixture.execute(
        await readFile(resolve(migrationsDir, filename), "utf8"),
      );
    }
    return await fixture.client.dumpDataDir("none");
  } finally {
    await fixture.close();
  }
}

// The dump is ready before the first test starts, so no test timeout
// includes the PGlite start.
const migratedDatabase = await dumpMigratedDatabase();

/** Create a migrated memory database that only the calling test uses. */
export async function createMemoryFixture(): Promise<MemoryFixture> {
  return await createLocalPgliteFixture<MemoryDb>(memorySqlSchema, {
    extensions,
    loadDataDir: migratedDatabase,
  });
}
