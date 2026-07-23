import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runMigrationJournal,
  type MigrationContextV1,
  type MigrationStateV1,
} from "@sentry/junior-migrations";
import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import type { StateAdapter } from "chat";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { createJiti } from "jiti";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../../fixtures/sql";
import { hasJuniorPostgresTestDatabase } from "../../fixtures/postgres/fixture";

const migrationLoader = createJiti(import.meta.url, { moduleCache: false });
const temporaryDirectories: string[] = [];

const unusedState: MigrationStateV1 = {
  acquireLock: async () => null,
  appendToList: async () => {},
  connect: async () => {},
  delete: async () => {},
  get: async () => undefined,
  getList: async () => [],
  releaseLock: async () => {},
  set: async () => {},
  setIfNotExists: async () => false,
};

async function createMigrationFolder(args: {
  source: string;
  tag: string;
  when: number;
}): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "junior-mixed-runner-"));
  temporaryDirectories.push(folder);
  await mkdir(join(folder, "meta"));
  await writeFile(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        {
          idx: 0,
          version: "7",
          when: args.when,
          tag: args.tag,
          breakpoints: true,
        },
      ],
    }),
  );
  await writeFile(join(folder, `${args.tag}.ts`), args.source);
  return folder;
}

function migrationOptions(args: {
  executor?: LocalJuniorSqlFixture["sql"];
  fixture: LocalJuniorSqlFixture;
  folder: string;
  table: string;
}) {
  const executor = args.executor ?? args.fixture.sql;
  return {
    executor,
    migrationsFolder: args.folder,
    migrationsTable: args.table,
    loadTypeScript: async (migrationPath: string) =>
      await migrationLoader.import<Record<string, unknown>>(migrationPath),
    createContext: ({
      progress,
    }: {
      progress: MigrationContextV1["progress"];
    }): MigrationContextV1 => ({
      database: executor,
      log: () => {},
      progress,
      state: unusedState,
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("mixed migration runner database contract", () => {
  it("provides the host Redis capability to plugin data migrations", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const folder = await createMigrationFolder({
      source: `
export default {
  apiVersion: 1,
  async up(context) {
    return {
      response: await context.redis.sendCommand(["PING"]),
    };
  },
};
`,
      tag: "0000_plugin_redis",
      when: 2_026_071_600_000,
    });
    const sendCommand = vi.fn(async () => "PONG");

    try {
      await expect(
        migratePluginSchemas(
          fixture.sql,
          [{ dir: folder, pluginName: "redis-test" }],
          {
            getStateContext: async () => ({
              redisStateAdapter: {
                getClient: () => ({ sendCommand }),
              } as unknown as RedisStateAdapter,
              stateAdapter: {} as StateAdapter,
            }),
            loadTypeScript: async (migrationPath) =>
              await migrationLoader.import<Record<string, unknown>>(
                migrationPath,
              ),
            mode: "all",
          },
        ),
      ).resolves.toEqual({
        existing: 0,
        migrated: 1,
        scanned: 1,
      });
      expect(sendCommand).toHaveBeenCalledWith(["PING"]);
    } finally {
      await fixture.close();
    }
  });

  it("persists failed progress and resumes a TypeScript migration", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const folder = await createMigrationFolder({
      source: `
export default {
  apiVersion: 1,
  async up(context) {
    const progress = await context.progress.load();
    if (progress === undefined) {
      await context.database.execute(
        "INSERT INTO mixed_runner_events (stage) VALUES ($1)",
        ["before-failure"],
      );
      await context.progress.save({ cursor: 1 });
      throw new Error("intentional migration interruption");
    }
    await context.database.execute(
      "INSERT INTO mixed_runner_events (stage) VALUES ($1)",
      ["after-resume"],
    );
    return { resumedFrom: progress.cursor };
  },
};
`,
      tag: "0000_resumable",
      when: 2_026_071_600_001,
    });
    const table = "__junior_mixed_runner_resume";
    const options = migrationOptions({ fixture, folder, table });

    try {
      await fixture.sql.execute(`
CREATE TABLE mixed_runner_events (
  id SERIAL PRIMARY KEY,
  stage TEXT NOT NULL
)
`);

      await expect(runMigrationJournal(options)).rejects.toThrow(
        "intentional migration interruption",
      );

      await expect(
        fixture.sql.query(
          `SELECT stage FROM mixed_runner_events ORDER BY id ASC`,
        ),
      ).resolves.toEqual([{ stage: "before-failure" }]);
      await expect(
        fixture.sql.query(`
SELECT
  name,
  kind,
  status,
  progress,
  result,
  completed_at IS NOT NULL AS "completed"
FROM drizzle.${table}
`),
      ).resolves.toEqual([
        {
          completed: false,
          kind: "typescript",
          name: "0000_resumable",
          progress: { cursor: 1 },
          result: null,
          status: "failed",
        },
      ]);

      await expect(runMigrationJournal(options)).resolves.toEqual({
        existing: 0,
        migrated: 1,
        scanned: 1,
        skipped: 0,
      });

      await expect(
        fixture.sql.query(
          `SELECT stage FROM mixed_runner_events ORDER BY id ASC`,
        ),
      ).resolves.toEqual([
        { stage: "before-failure" },
        { stage: "after-resume" },
      ]);
      await expect(
        fixture.sql.query(`
SELECT
  status,
  progress,
  result,
  completed_at IS NOT NULL AS "completed"
FROM drizzle.${table}
`),
      ).resolves.toEqual([
        {
          completed: true,
          progress: { cursor: 1 },
          result: { resumedFrom: 1 },
          status: "completed",
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it.skipIf(!hasJuniorPostgresTestDatabase())(
    "serializes concurrent runs and executes a TypeScript migration once",
    async () => {
      const fixture = await createLocalJuniorSqlFixture();
      const folder = await createMigrationFolder({
        source: `
export default {
  apiVersion: 1,
  async up(context) {
    await context.database.execute(
      "INSERT INTO mixed_runner_lock_events (stage) VALUES ($1)",
      ["body"],
    );
    while (true) {
      const [barrier] = await context.database.query(
        "SELECT released FROM mixed_runner_lock_barrier WHERE id = 1",
      );
      if (barrier?.released === true) break;
      await context.database.query("SELECT pg_sleep(0.01)");
    }
    return { executed: true };
  },
};
`,
        tag: "0000_locked",
        when: 2_026_071_600_002,
      });
      const table = "__junior_mixed_runner_lock";
      let lockAttempts = 0;
      const observedExecutor = new Proxy(fixture.sql, {
        get(target, key, receiver) {
          if (key === "withMigrationLock") {
            return async (
              migrationTable: string,
              callback: () => Promise<unknown>,
            ) => {
              lockAttempts += 1;
              return await target.withMigrationLock(migrationTable, callback);
            };
          }
          const value = Reflect.get(target, key, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const options = migrationOptions({
        executor: observedExecutor,
        fixture,
        folder,
        table,
      });

      try {
        await fixture.sql.execute(`
CREATE TABLE mixed_runner_lock_events (
  id SERIAL PRIMARY KEY,
  stage TEXT NOT NULL
);
CREATE TABLE mixed_runner_lock_barrier (
  id INTEGER PRIMARY KEY,
  released BOOLEAN NOT NULL
);
INSERT INTO mixed_runner_lock_barrier (id, released) VALUES (1, false)
`);

        const first = runMigrationJournal(options);
        await vi.waitFor(async () => {
          await expect(
            fixture.sql.query(
              "SELECT count(*)::integer AS count FROM mixed_runner_lock_events",
            ),
          ).resolves.toEqual([{ count: 1 }]);
        });
        const second = runMigrationJournal(options);
        await vi.waitFor(() => expect(lockAttempts).toBe(2));
        await expect(
          fixture.sql.query(
            "SELECT count(*)::integer AS count FROM mixed_runner_lock_events",
          ),
        ).resolves.toEqual([{ count: 1 }]);
        await fixture.sql.execute(
          "UPDATE mixed_runner_lock_barrier SET released = true WHERE id = 1",
        );
        const results = await Promise.all([first, second]);

        expect(results).toEqual(
          expect.arrayContaining([
            { existing: 0, migrated: 1, scanned: 1, skipped: 0 },
            { existing: 1, migrated: 0, scanned: 1, skipped: 0 },
          ]),
        );
        await expect(
          fixture.sql.query(
            `SELECT stage FROM mixed_runner_lock_events ORDER BY id ASC`,
          ),
        ).resolves.toEqual([{ stage: "body" }]);
        await expect(
          fixture.sql.query(`SELECT status, result FROM drizzle.${table}`),
        ).resolves.toEqual([
          { result: { executed: true }, status: "completed" },
        ]);
      } finally {
        await fixture.close();
      }
    },
    15_000,
  );
});
