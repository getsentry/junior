import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createMemoryState } from "@chat-adapter/state-memory";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import {
  createSchedulerSqlStore,
  schedulerPlugin,
  type SchedulerDb,
  type ScheduledTask,
} from "@sentry/junior-scheduler";
import { createSchedulerStore } from "../../../junior-scheduler/src/store";
import { defineJuniorPlugins } from "@/plugins";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { createPluginState } from "@/chat/plugins/state";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { runPluginStorageMigrations } from "@/cli/upgrade/migrations/plugin-storage";
import { migratePluginsToSql } from "@/cli/upgrade/migrations/plugin-sql";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

const NEON = vi.hoisted(() => ({
  originalDatabaseUrl: process.env.DATABASE_URL,
  sql: undefined as
    | Awaited<ReturnType<typeof createLocalJuniorSqlFixture>>["sql"]
    | undefined,
}));

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://configured.example.test/neon";
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

vi.mock("@/db/executor", () => ({
  createJuniorSqlExecutor: vi.fn(() => {
    if (!NEON.sql) {
      throw new Error("Missing test SQL executor");
    }
    return {
      db: NEON.sql.db.bind(NEON.sql),
      execute: NEON.sql.execute.bind(NEON.sql),
      query: NEON.sql.query.bind(NEON.sql),
      migrate: NEON.sql.migrate.bind(NEON.sql),
      transaction: NEON.sql.transaction.bind(NEON.sql),
      withLock: NEON.sql.withLock.bind(NEON.sql),
      withMigrationLock: NEON.sql.withMigrationLock.bind(NEON.sql),
      close: async () => {},
    };
  }),
}));

const TEST_RUN_AT_MS = Date.parse("2026-05-26T12:00:00.000Z");
const TEST_NOW_MS = Date.parse("2026-05-26T12:05:00.000Z");
const LEGACY_SCHEDULER_MIGRATION_CHECKSUM =
  "d1d2f712181dd3a0557808f0fc67fd0722691d25f4c8cfb816b77c71d19e1e42";

function schedulerMigrationsDir(): string {
  return path.resolve(process.cwd(), "../junior-scheduler/migrations");
}

function memoryMigrationsDir(): string {
  return path.resolve(process.cwd(), "../junior-memory/migrations");
}

async function migrateSchedulerSchema(
  fixture: Awaited<ReturnType<typeof createLocalJuniorSqlFixture>>,
) {
  await migratePluginSchemas(fixture.sql, [
    {
      dir: schedulerMigrationsDir(),
      pluginName: "scheduler",
    },
  ]);
}

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "sched_sql_1",
    createdAtMs: TEST_RUN_AT_MS,
    createdBy: { slackUserId: "U123" },
    credentialMode: "system",
    destination: {
      platform: "slack",
      teamId: "T123",
      channelId: "C123",
    },
    nextRunAtMs: TEST_RUN_AT_MS,
    schedule: {
      description: "Once at noon",
      kind: "one_off",
      timezone: "UTC",
    },
    status: "active",
    task: {
      text: "Post a digest.",
    },
    updatedAtMs: TEST_RUN_AT_MS,
    ...overrides,
  };
}

describe("scheduler SQL plugin storage", () => {
  afterAll(() => {
    if (NEON.originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = NEON.originalDatabaseUrl;
    }
  });

  afterEach(async () => {
    NEON.sql = undefined;
    await disconnectStateAdapter();
  });

  it("adopts deployed scheduler schema state into its Drizzle journal", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchedulerSchema(fixture);
      const [migrationTable] = await fixture.sql.query<{ tablename: string }>(`
SELECT tablename
FROM pg_tables
WHERE schemaname = 'drizzle'
  AND tablename LIKE '__drizzle_scheduler_%'
`);
      expect(migrationTable).toBeDefined();
      await fixture.sql.execute(
        `DROP TABLE drizzle.${migrationTable!.tablename}`,
      );
      await fixture.sql.execute(`
CREATE TABLE junior_schema_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`);
      await fixture.sql.execute(
        `INSERT INTO junior_schema_migrations (id, checksum) VALUES ($1, $2)`,
        [
          "plugin:scheduler/0001_scheduler.sql",
          LEGACY_SCHEDULER_MIGRATION_CHECKSUM,
        ],
      );
      const currentTask = createTask({ id: "sched_legacy_credential_subject" });
      const { credentialMode: _credentialMode, ...legacyTask } = currentTask;
      await fixture.sql.execute(
        `
INSERT INTO junior_scheduler_tasks (
  id,
  team_id,
  status,
  next_run_at_ms,
  created_at_ms,
  record
) VALUES ($1, $2, $3, $4, $5, $6)
`,
        [
          legacyTask.id,
          legacyTask.destination.teamId,
          legacyTask.status,
          legacyTask.nextRunAtMs,
          legacyTask.createdAtMs,
          JSON.stringify({
            ...legacyTask,
            credentialSubject: {
              type: "user",
              userId: "slack:T123:U123",
              allowedWhen: "private-direct-conversation",
            },
          }),
        ],
      );

      await expect(
        migratePluginSchemas(fixture.sql, [
          {
            dir: schedulerMigrationsDir(),
            pluginName: "scheduler",
          },
        ]),
      ).resolves.toEqual({ existing: 1, migrated: 1, scanned: 2 });
      const migrations = readMigrationFiles({
        migrationsFolder: schedulerMigrationsDir(),
      });
      const migrationRows = await fixture.sql.query<{
        createdAt: string;
        hash: string;
      }>(`
SELECT hash, created_at::text AS "createdAt"
FROM drizzle.${migrationTable!.tablename}
ORDER BY created_at
`);
      expect(migrationRows).toEqual(
        migrations.map((migration) => ({
          createdAt: String(migration.folderMillis),
          hash: migration.hash,
        })),
      );
      const [migratedTask] = await fixture.sql.query<{ record: unknown }>(
        `SELECT record FROM junior_scheduler_tasks WHERE id = $1`,
        [legacyTask.id],
      );
      expect(migratedTask?.record).toMatchObject({
        credentialMode: "system",
      });
      expect(migratedTask?.record).not.toHaveProperty("credentialSubject");
      await expect(
        migratePluginSchemas(fixture.sql, [
          {
            dir: schedulerMigrationsDir(),
            pluginName: "scheduler",
          },
        ]),
      ).resolves.toEqual({ existing: 2, migrated: 0, scanned: 2 });
      await expect(
        fixture.sql.query<{
          createdAt: string;
          hash: string;
        }>(`
SELECT hash, created_at::text AS "createdAt"
FROM drizzle.${migrationTable!.tablename}
ORDER BY created_at
`),
      ).resolves.toEqual(migrationRows);
    } finally {
      await fixture.close();
    }
  });

  it("keeps migration state isolated across plugins", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const roots = [
      { dir: schedulerMigrationsDir(), pluginName: "scheduler" },
      { dir: memoryMigrationsDir(), pluginName: "memory" },
    ];
    const migrationCount = roots.reduce(
      (count, root) =>
        count + readMigrationFiles({ migrationsFolder: root.dir }).length,
      0,
    );

    try {
      await expect(migratePluginSchemas(fixture.sql, roots)).resolves.toEqual({
        existing: 0,
        migrated: migrationCount,
        scanned: migrationCount,
      });
      const migrationTables = await fixture.sql.query<{ tablename: string }>(`
SELECT tablename
FROM pg_tables
WHERE schemaname = 'drizzle'
  AND tablename LIKE '__drizzle_%'
ORDER BY tablename
`);
      expect(migrationTables).toHaveLength(2);
      await expect(
        migratePluginSchemas(fixture.sql, [...roots].reverse()),
      ).resolves.toEqual({
        existing: migrationCount,
        migrated: 0,
        scanned: migrationCount,
      });
    } finally {
      await fixture.close();
    }
  });

  it("rejects missing and invalid Drizzle journals", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const missingJournal = mkdtempSync(
      path.join(tmpdir(), "junior-missing-journal-"),
    );
    const invalidJournal = mkdtempSync(
      path.join(tmpdir(), "junior-invalid-journal-"),
    );
    mkdirSync(path.join(invalidJournal, "meta"));
    writeFileSync(path.join(invalidJournal, "meta", "_journal.json"), "{");

    try {
      await expect(
        migratePluginSchemas(fixture.sql, [
          { dir: missingJournal, pluginName: "missing" },
        ]),
      ).rejects.toThrow("Can't find meta/_journal.json file");
      await expect(
        migratePluginSchemas(fixture.sql, [
          { dir: invalidJournal, pluginName: "invalid" },
        ]),
      ).rejects.toThrow("Expected property name");
    } finally {
      rmSync(missingJournal, { force: true, recursive: true });
      rmSync(invalidJournal, { force: true, recursive: true });
      await fixture.close();
    }
  });

  it("persists and claims scheduled runs through the plugin SQL database", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchedulerSchema(fixture);
      const db = fixture.sql.db() as unknown as SchedulerDb;
      const store = createSchedulerSqlStore(db);
      const task = createTask();

      await store.saveTask(task);

      await expect(store.listTasksForTeam("T123")).resolves.toMatchObject([
        { id: task.id },
      ]);
      const run = await store.claimDueRun({ nowMs: TEST_NOW_MS });
      expect(run).toMatchObject({
        taskId: task.id,
        scheduledForMs: TEST_RUN_AT_MS,
        status: "pending",
      });

      const dispatched = await store.markRunDispatched({
        claimedAtMs: run!.claimedAtMs,
        dispatchId: "dispatch_1",
        nowMs: TEST_NOW_MS + 1,
        runId: run!.id,
      });
      expect(dispatched).toMatchObject({ status: "running" });

      const completed = await store.markRunCompleted({
        completedAtMs: TEST_NOW_MS + 2,
        resultMessageTs: "1718123456.000000",
        runId: run!.id,
        startedAtMs: dispatched!.startedAtMs!,
      });
      expect(completed).toMatchObject({ status: "completed" });

      await store.updateTaskAfterRun({
        nowMs: TEST_NOW_MS + 3,
        run: completed!,
        status: "completed",
      });

      await expect(store.getTask(task.id)).resolves.toMatchObject({
        id: task.id,
        lastRunAtMs: TEST_RUN_AT_MS,
        status: "paused",
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("claims later due runs when an older pending run is stale", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchedulerSchema(fixture);
      const db = fixture.sql.db() as unknown as SchedulerDb;
      const store = createSchedulerSqlStore(db);
      const taskId = "sched_sql_stale_pending";
      const staleRunAtMs = TEST_NOW_MS - 2 * 60 * 1000;
      const nextRunAtMs = TEST_NOW_MS - 30 * 1000;
      const task = createTask({
        id: taskId,
        nextRunAtMs: staleRunAtMs,
      });

      await store.saveTask(task);
      const staleRun = await store.claimDueRun({ nowMs: staleRunAtMs });
      expect(staleRun).toMatchObject({
        id: `${taskId}:${staleRunAtMs}`,
        status: "pending",
      });

      await store.saveTask({
        ...task,
        nextRunAtMs,
        updatedAtMs: TEST_NOW_MS,
      });
      const nextRun = await store.claimDueRun({ nowMs: TEST_NOW_MS });

      expect(nextRun).toMatchObject({
        id: `${taskId}:${nextRunAtMs}`,
        scheduledForMs: nextRunAtMs,
        status: "pending",
      });
      await expect(store.getRun(staleRun!.id)).resolves.toMatchObject({
        status: "pending",
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("does not reclaim completed SQL run slots", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchedulerSchema(fixture);
      const db = fixture.sql.db() as unknown as SchedulerDb;
      const store = createSchedulerSqlStore(db);
      const task = createTask({ id: "sched_sql_completed_slot" });

      await store.saveTask(task);
      const run = await store.claimDueRun({ nowMs: TEST_NOW_MS });
      expect(run).toMatchObject({
        id: `${task.id}:${TEST_RUN_AT_MS}`,
        status: "pending",
      });

      const dispatched = await store.markRunDispatched({
        claimedAtMs: run!.claimedAtMs,
        dispatchId: "dispatch_completed_slot",
        nowMs: TEST_NOW_MS + 1,
        runId: run!.id,
      });
      await expect(
        store.markRunCompleted({
          completedAtMs: TEST_NOW_MS + 2,
          runId: run!.id,
          startedAtMs: dispatched!.startedAtMs!,
        }),
      ).resolves.toMatchObject({
        id: run!.id,
        status: "completed",
      });

      await expect(store.claimDueRun({ nowMs: TEST_NOW_MS + 3 })).resolves.toBe(
        undefined,
      );
      await expect(store.getRun(run!.id)).resolves.toMatchObject({
        id: run!.id,
        status: "completed",
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("reclaims blocked SQL run slots after reactivation", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchedulerSchema(fixture);
      const db = fixture.sql.db() as unknown as SchedulerDb;
      const store = createSchedulerSqlStore(db);
      const task = createTask({ id: "sched_sql_blocked_slot" });

      await store.saveTask(task);
      const run = await store.claimDueRun({ nowMs: TEST_NOW_MS });
      expect(run).toMatchObject({
        id: `${task.id}:${TEST_RUN_AT_MS}`,
        status: "pending",
      });

      await expect(
        store.markRunBlocked({
          completedAtMs: TEST_NOW_MS + 1,
          errorMessage: "Missing provider authorization.",
          runId: run!.id,
        }),
      ).resolves.toMatchObject({
        id: run!.id,
        status: "blocked",
      });

      await store.updateTaskAfterRun({
        errorMessage: "Missing provider authorization.",
        nowMs: TEST_NOW_MS + 2,
        run: {
          ...run!,
          completedAtMs: TEST_NOW_MS + 1,
          errorMessage: "Missing provider authorization.",
          status: "blocked",
        },
        status: "blocked",
      });
      await expect(store.getTask(task.id)).resolves.toMatchObject({
        id: task.id,
        status: "blocked",
      });

      await store.saveTask({
        ...task,
        nextRunAtMs: TEST_RUN_AT_MS,
        status: "active",
        statusReason: undefined,
        updatedAtMs: TEST_NOW_MS + 3,
      });

      await expect(
        store.claimDueRun({ nowMs: TEST_NOW_MS + 4 }),
      ).resolves.toMatchObject({
        id: `${task.id}:${TEST_RUN_AT_MS}`,
        scheduledForMs: TEST_RUN_AT_MS,
        status: "pending",
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("migrates existing scheduler plugin state into SQL idempotently", async () => {
    const stateAdapter = createMemoryState();
    await stateAdapter.connect();
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchedulerSchema(fixture);
      const db = fixture.sql.db() as unknown as SchedulerDb;
      const stateStore = createSchedulerStore(
        createPluginState("scheduler", stateAdapter),
      );
      const task = createTask({ id: "sched_state_sql" });
      await stateStore.saveTask(task);
      const run = await stateStore.claimDueRun({ nowMs: TEST_NOW_MS });
      expect(run).toBeDefined();

      const context = {
        db,
        io: { info: () => {} },
        pluginSet: defineJuniorPlugins([schedulerPlugin()]),
        stateAdapter,
      };

      await expect(runPluginStorageMigrations(context)).resolves.toEqual({
        existing: 0,
        migrated: 2,
        missing: 0,
        scanned: 2,
      });
      await expect(runPluginStorageMigrations(context)).resolves.toEqual({
        existing: 2,
        migrated: 0,
        missing: 0,
        scanned: 2,
      });

      const sqlStore = createSchedulerSqlStore(db);
      await expect(sqlStore.getTask(task.id)).resolves.toMatchObject({
        id: task.id,
      });
      await expect(sqlStore.getRun(run!.id)).resolves.toMatchObject({
        id: run!.id,
        taskId: task.id,
      });
    } finally {
      await stateAdapter.disconnect();
      await fixture.close();
    }
  }, 15_000);

  it("skips malformed scheduler state records during SQL storage migration", async () => {
    const stateAdapter = createMemoryState();
    await stateAdapter.connect();
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchedulerSchema(fixture);
      const db = fixture.sql.db() as unknown as SchedulerDb;
      const state = createPluginState("scheduler", stateAdapter);
      const task = createTask({ id: "sched_state_sql_valid_after_bad" });
      const { credentialMode: _credentialMode, ...legacyTask } = task;
      const badRunId = `${task.id}:${TEST_RUN_AT_MS}`;
      await state.set(
        "junior:scheduler:tasks",
        ["sched_state_sql_bad", task.id],
        5 * 60 * 1000,
      );
      await state.set(
        `junior:scheduler:task:${task.id}`,
        {
          ...legacyTask,
          credentialSubject: {
            type: "user",
            userId: "U123",
            allowedWhen: "private-direct-conversation",
          },
        },
        5 * 60 * 1000,
      );
      await state.set(
        "junior:scheduler:task:sched_state_sql_bad",
        {
          ...task,
          id: "sched_state_sql_bad",
          task: { text: 123 },
        },
        5 * 60 * 1000,
      );
      await state.set(
        `junior:scheduler:active:${task.id}`,
        {
          claimedAtMs: TEST_NOW_MS,
          runId: badRunId,
          scheduledForMs: TEST_RUN_AT_MS,
        },
        5 * 60 * 1000,
      );
      await state.set(
        `junior:scheduler:run:${badRunId}`,
        { id: badRunId },
        5 * 60 * 1000,
      );

      await expect(
        runPluginStorageMigrations({
          db,
          io: { info: () => {} },
          pluginSet: defineJuniorPlugins([schedulerPlugin()]),
          stateAdapter,
        }),
      ).resolves.toEqual({
        existing: 0,
        migrated: 1,
        missing: 1,
        scanned: 2,
      });

      const sqlStore = createSchedulerSqlStore(db);
      await expect(sqlStore.getTask(task.id)).resolves.toMatchObject({
        credentialMode: "system",
        id: task.id,
      });
      await expect(sqlStore.getTask("sched_state_sql_bad")).resolves.toBe(
        undefined,
      );
      await expect(sqlStore.getRun(badRunId)).resolves.toBe(undefined);
    } finally {
      await stateAdapter.disconnect();
      await fixture.close();
    }
  }, 15_000);

  it("does not load scheduler storage migration from package-only plugin set", async () => {
    const stateAdapter = createMemoryState();
    await stateAdapter.connect();
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchedulerSchema(fixture);
      const db = fixture.sql.db() as unknown as SchedulerDb;
      const stateStore = createSchedulerStore(
        createPluginState("scheduler", stateAdapter),
      );
      const task = createTask({ id: "sched_package_config" });
      await stateStore.saveTask(task);
      const run = await stateStore.claimDueRun({ nowMs: TEST_NOW_MS });
      expect(run).toBeDefined();

      await expect(
        runPluginStorageMigrations({
          db,
          io: { info: () => {} },
          pluginSet: defineJuniorPlugins(["@sentry/junior-scheduler"]),
          stateAdapter,
        }),
      ).resolves.toEqual({
        existing: 0,
        migrated: 0,
        missing: 0,
        scanned: 0,
      });

      const sqlStore = createSchedulerSqlStore(db);
      await expect(sqlStore.getTask(task.id)).resolves.toBe(undefined);
      await expect(sqlStore.getRun(run!.id)).resolves.toBe(undefined);
    } finally {
      await stateAdapter.disconnect();
      await fixture.close();
    }
  }, 15_000);

  it("does not apply scheduler SQL migrations from package-only config", async () => {
    const stateAdapter = createMemoryState();
    await stateAdapter.connect();
    const fixture = await createLocalJuniorSqlFixture();
    NEON.sql = fixture.sql;

    try {
      await expect(
        migratePluginsToSql({
          io: { info: () => {} },
          pluginCatalogConfig: { packages: ["@sentry/junior-scheduler"] },
          stateAdapter,
        }),
      ).resolves.toEqual({
        existing: 0,
        migrated: 0,
        missing: 0,
        scanned: 0,
      });
    } finally {
      await stateAdapter.disconnect();
      await fixture.close();
    }
  });

  it("applies scheduler SQL migrations from registration-only config", async () => {
    const stateAdapter = createMemoryState();
    await stateAdapter.connect();
    const fixture = await createLocalJuniorSqlFixture();
    NEON.sql = fixture.sql;

    try {
      await expect(
        migratePluginsToSql({
          io: { info: () => {} },
          pluginSet: defineJuniorPlugins([schedulerPlugin()]),
          stateAdapter,
        }),
      ).resolves.toEqual({
        existing: 0,
        migrated: 2,
        missing: 0,
        scanned: 2,
      });

      const db = fixture.sql.db() as unknown as SchedulerDb;
      const store = createSchedulerSqlStore(db);
      const task = createTask({ id: "sched_schema_registration_config" });
      await store.saveTask(task);
      await expect(store.getTask(task.id)).resolves.toMatchObject({
        id: task.id,
      });
    } finally {
      await stateAdapter.disconnect();
      await fixture.close();
    }
  });

  it("does not duplicate scheduler SQL migrations for explicit registrations", async () => {
    const stateAdapter = createMemoryState();
    await stateAdapter.connect();
    const fixture = await createLocalJuniorSqlFixture();
    NEON.sql = fixture.sql;

    try {
      await expect(
        migratePluginsToSql({
          io: { info: () => {} },
          pluginSet: defineJuniorPlugins([
            "@sentry/junior-scheduler",
            schedulerPlugin(),
          ]),
          stateAdapter,
        }),
      ).resolves.toEqual({
        existing: 0,
        migrated: 2,
        missing: 0,
        scanned: 2,
      });
    } finally {
      await stateAdapter.disconnect();
      await fixture.close();
    }
  });

  it("skips malformed SQL records while claiming due runs", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchedulerSchema(fixture);
      const db = fixture.sql.db() as unknown as SchedulerDb;
      const store = createSchedulerSqlStore(db);
      const task = createTask({ id: "sched_valid_after_bad_record" });

      await fixture.sql.execute(
        `
INSERT INTO junior_scheduler_tasks (
  id,
  team_id,
  status,
  next_run_at_ms,
  created_at_ms,
  record
) VALUES ($1, $2, $3, $4, $5, $6)
`,
        [
          "sched_bad_record",
          task.destination.teamId,
          "active",
          TEST_RUN_AT_MS,
          TEST_RUN_AT_MS - 1,
          JSON.stringify({ id: "sched_bad_record" }),
        ],
      );
      await store.saveTask(task);
      await expect(store.getTask("sched_bad_record")).resolves.toBe(undefined);
      await fixture.sql.execute(
        `
INSERT INTO junior_scheduler_tasks (
  id,
  team_id,
  status,
  next_run_at_ms,
  created_at_ms,
  record
) VALUES ($1, $2, $3, $4, $5, $6)
`,
        [
          "sched_bad_string_record",
          task.destination.teamId,
          "active",
          TEST_RUN_AT_MS,
          TEST_RUN_AT_MS - 1,
          JSON.stringify("not-json"),
        ],
      );
      await expect(store.getTask("sched_bad_string_record")).resolves.toBe(
        undefined,
      );
      await fixture.sql.execute(
        `
INSERT INTO junior_scheduler_runs (
  id,
  task_id,
  status,
  scheduled_for_ms,
  record
) VALUES ($1, $2, $3, $4, $5)
`,
        [
          "sched_bad_run",
          task.id,
          "pending",
          TEST_RUN_AT_MS - 60_000,
          JSON.stringify({ id: "sched_bad_run" }),
        ],
      );
      await expect(store.getRun("sched_bad_run")).resolves.toBe(undefined);
      await fixture.sql.execute(
        `
INSERT INTO junior_scheduler_runs (
  id,
  task_id,
  status,
  scheduled_for_ms,
  record
) VALUES ($1, $2, $3, $4, $5)
`,
        [
          "sched_bad_string_run",
          task.id,
          "pending",
          TEST_RUN_AT_MS - 60_000,
          JSON.stringify("not-json"),
        ],
      );
      await expect(store.getRun("sched_bad_string_run")).resolves.toBe(
        undefined,
      );

      await expect(
        store.claimDueRun({ nowMs: TEST_NOW_MS }),
      ).resolves.toMatchObject({
        id: `${task.id}:${TEST_RUN_AT_MS}`,
        taskId: task.id,
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("passes database access to plugin storage migrations", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const db = fixture.sql.db() as unknown as SchedulerDb;
      let receivedDb: unknown;
      const plugin = defineJuniorPlugin({
        manifest: {
          name: "stateless",
          displayName: "Stateless",
          description: "Storage migration with database access",
        },
        hooks: {
          migrateStorage(ctx) {
            receivedDb = ctx.db;
            return {
              existing: 0,
              migrated: 0,
              missing: 0,
              scanned: 1,
            };
          },
        },
      });

      await expect(
        runPluginStorageMigrations({
          db,
          io: { info: () => {} },
          pluginSet: defineJuniorPlugins([plugin]),
          stateAdapter,
        }),
      ).resolves.toEqual({
        existing: 0,
        migrated: 0,
        missing: 0,
        scanned: 1,
      });
      expect(receivedDb).toBe(db);
    } finally {
      await fixture.close();
    }
  }, 15_000);
});
