import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PluginCache } from "@sentry/junior-plugin-api";
import {
  createLocalPgliteFixture,
  type LocalPgliteFixture,
} from "@sentry/junior-testing/pglite";
import * as sentrySqlSchema from "../src/db/schema";
import type { SentryDb } from "../src/db/database";

/** Create an in-memory database with the packaged migrations applied. */
export async function createSentryDb(): Promise<LocalPgliteFixture<SentryDb>> {
  const fixture = await createLocalPgliteFixture<SentryDb>(sentrySqlSchema);
  const dir = resolve(__dirname, "../migrations");
  for (const file of (await readdir(dir))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    await fixture.execute(await readFile(resolve(dir, file), "utf8"));
  }
  return fixture;
}

/** A plugin cache that keeps entries in memory, like the shared state cache. */
export function memoryCache(): PluginCache {
  const entries = new Map<string, unknown>();
  return {
    async getOrLoad(key, load, options) {
      if (!options?.refresh && entries.has(key)) {
        return entries.get(key) as never;
      }
      const entry = await load();
      if (entry.ttlMs !== undefined) entries.set(key, entry.value);
      return entry.value;
    },
  };
}
