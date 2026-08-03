import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it, vi } from "vitest";
import {
  pluginApiRouteRequestContextSchema,
  pluginUserPageContentSchema,
  type PluginLogger,
} from "@sentry/junior-plugin-api";
import {
  createSchedulerSqlStore,
  schedulerPlugin,
  type SchedulerDb,
  type ScheduledTask,
} from "@sentry/junior-scheduler";
import { defineJuniorPlugins } from "@/plugins";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { migratePluginsToSql } from "@/cli/upgrade/migrations/plugin-sql";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

const TEST_RUN_AT_MS = Date.parse("2026-05-26T12:00:00.000Z");
const TEST_NOW_MS = Date.parse("2026-05-26T12:05:00.000Z");
const LEGACY_SCHEDULER_MIGRATION_CHECKSUM =
  "d1d2f712181dd3a0557808f0fc67fd0722691d25f4c8cfb816b77c71d19e1e42";
const noopLogger: PluginLogger = {
  error() {},
  info() {},
  warn() {},
};

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
    conversationAccess: { audience: "channel", visibility: "public" },
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
  it("adopts deployed scheduler schema state into its Drizzle journal", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await migrateSchedulerSchema(fixture);
      const [migrationTable] = await fixture.sql.query<{ tablename: string }>(`
SELECT tablename
FROM pg_tables
WHERE schemaname = 'drizzle'
  AND tablename LIKE '__drizzle_scheduler_%'
`);
      expect(migrationTable).toBeDefined();
      await fixture.sql.execute(
        `DROP INDEX junior_scheduler_tasks_creator_idx`,
      );
      await fixture.sql.execute(
        `ALTER TABLE junior_scheduler_tasks DROP COLUMN creator_slack_user_id`,
      );
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
      await fixture.sql.execute(
        `
INSERT INTO junior_destinations (
  id,
  provider,
  provider_tenant_id,
  provider_destination_id,
  kind,
  visibility,
  created_at,
  updated_at
) VALUES ($1, 'slack', $2, $3, 'channel', 'public', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`,
        ["destination_scheduler_public", "T123", "C123"],
      );
      const currentTask = createTask({ id: "sched_legacy_credential_subject" });
      const {
        conversationAccess: _conversationAccess,
        credentialMode: _credentialMode,
        ...legacyTask
      } = currentTask;
      const unmatchedCurrentTask = createTask({
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C404",
        },
        id: "sched_legacy_unknown_destination",
      });
      const {
        conversationAccess: _unmatchedConversationAccess,
        credentialMode: _unmatchedCredentialMode,
        ...unmatchedLegacyTask
      } = unmatchedCurrentTask;
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
          unmatchedLegacyTask.id,
          unmatchedLegacyTask.destination.teamId,
          unmatchedLegacyTask.status,
          unmatchedLegacyTask.nextRunAtMs,
          unmatchedLegacyTask.createdAtMs,
          JSON.stringify(unmatchedLegacyTask),
        ],
      );

      await expect(
        migratePluginSchemas(fixture.sql, [
          {
            dir: schedulerMigrationsDir(),
            pluginName: "scheduler",
          },
        ]),
      ).resolves.toEqual({ existing: 1, migrated: 3, scanned: 4 });
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
      const [migratedTask] = await fixture.sql.query<{
        creatorSlackUserId: string;
        record: unknown;
      }>(
        `
SELECT
  creator_slack_user_id AS "creatorSlackUserId",
  record
FROM junior_scheduler_tasks
WHERE id = $1
`,
        [legacyTask.id],
      );
      expect(migratedTask?.creatorSlackUserId).toBe("U123");
      expect(migratedTask?.record).toMatchObject({
        conversationAccess: {
          audience: "channel",
          visibility: "public",
        },
        credentialMode: "system",
      });
      expect(migratedTask?.record).not.toHaveProperty("credentialSubject");
      const [unmatchedMigratedTask] = await fixture.sql.query<{
        record: unknown;
      }>(`SELECT record FROM junior_scheduler_tasks WHERE id = $1`, [
        unmatchedLegacyTask.id,
      ]);
      expect(unmatchedMigratedTask?.record).toMatchObject({
        conversationAccess: {
          audience: "channel",
          visibility: "private",
        },
      });
      await expect(
        migratePluginSchemas(fixture.sql, [
          {
            dir: schedulerMigrationsDir(),
            pluginName: "scheduler",
          },
        ]),
      ).resolves.toEqual({ existing: 4, migrated: 0, scanned: 4 });
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
      const migrationLock = vi.spyOn(fixture.sql, "withMigrationLock");
      const summaries: string[] = [];
      await expect(
        migratePluginSchemas(fixture.sql, [...roots].reverse(), {
          onPluginMigration: ({ pluginName }) => summaries.push(pluginName),
        }),
      ).resolves.toEqual({
        existing: migrationCount,
        migrated: 0,
        scanned: migrationCount,
      });
      expect(migrationLock).not.toHaveBeenCalled();
      expect(summaries).toEqual(["memory", "scheduler"]);
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

  it("lists viewer-created tasks with search and cursor pagination", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchedulerSchema(fixture);
      const db = fixture.sql.db() as unknown as SchedulerDb;
      const store = createSchedulerSqlStore(db);
      const visibleOld = createTask({
        createdAtMs: TEST_RUN_AT_MS + 100,
        id: "sched_visible_old",
        schedule: {
          description: "Every Friday",
          kind: "recurring",
          timezone: "UTC",
        },
        task: { text: "Prepare the weekly summary." },
      });
      const visibleNew = createTask({
        createdAtMs: TEST_RUN_AT_MS + 200,
        id: "sched_visible_new",
        nextRunAtMs: TEST_NOW_MS + 60_000,
        runNowAtMs: TEST_NOW_MS,
        task: { text: "Post the daily summary." },
      });
      await store.saveTask(visibleOld);
      await store.saveTask(visibleNew);
      await fixture.sql.execute(
        `
INSERT INTO junior_scheduler_tasks (
  id,
  team_id,
  creator_slack_user_id,
  status,
  created_at_ms,
  record
) VALUES ($1, $2, $3, $4, $5, $6)
`,
        [
          "sched_malformed_between_pages",
          visibleNew.destination.teamId,
          visibleNew.createdBy.slackUserId,
          "active",
          TEST_RUN_AT_MS + 150,
          JSON.stringify({ id: "sched_malformed_between_pages" }),
        ],
      );
      await store.saveTask(
        createTask({
          createdAtMs: TEST_RUN_AT_MS + 300,
          createdBy: { slackUserId: "U999" },
          id: "sched_other_creator",
        }),
      );
      await store.saveTask(
        createTask({
          createdAtMs: TEST_RUN_AT_MS + 400,
          destination: {
            platform: "slack",
            teamId: "T999",
            channelId: "C999",
          },
          id: "sched_other_workspace",
        }),
      );

      const page = schedulerPlugin().userPages?.[0];
      expect(page).toBeDefined();
      const context = {
        db,
        log: noopLogger,
        plugin: { name: "scheduler" },
        viewer: {
          actors: [
            {
              platform: "slack" as const,
              teamId: "T123",
              userId: "U123",
            },
          ],
          email: "person@example.com",
        },
      };
      const first = pluginUserPageContentSchema.parse(
        await page!.read(context, { limit: 1 }),
      );
      expect(first.records).toEqual([
        expect.objectContaining({
          id: visibleNew.id,
          metadata: expect.arrayContaining([
            {
              label: "Next run",
              value: expect.stringContaining("12:05 PM UTC"),
            },
          ]),
        }),
      ]);
      expect(first.nextCursor).toEqual(expect.any(String));

      const second = pluginUserPageContentSchema.parse(
        await page!.read(context, {
          cursor: first.nextCursor,
          limit: 1,
        }),
      );
      expect(second.records).toEqual([
        expect.objectContaining({ id: visibleOld.id }),
      ]);

      const search = pluginUserPageContentSchema.parse(
        await page!.read(context, { limit: 20, query: "friday" }),
      );
      expect(search.records).toEqual([
        expect.objectContaining({ id: visibleOld.id }),
      ]);

      const api = schedulerPlugin().hooks?.apiRoutes?.({
        db,
        eventStats: {
          async costsByDay() {
            throw new Error("Scheduler API test does not read event stats");
          },
        },
        log: noopLogger,
        plugin: { name: "scheduler" },
        viewer: { actors: async () => context.viewer.actors },
      });
      expect(api).toBeDefined();
      const requestContext = pluginApiRouteRequestContextSchema.parse({
        auth: {
          user: {
            email: context.viewer.email,
            emailVerified: true,
          },
        },
        pluginName: "scheduler",
      });
      const deleteResponse = await api!.fetch(
        new Request(`http://localhost/tasks/${visibleOld.id}`, {
          method: "DELETE",
        }),
        requestContext,
      );
      expect(deleteResponse.status).toBe(204);
      await expect(store.getTask(visibleOld.id)).resolves.toMatchObject({
        status: "deleted",
      });

      const forbiddenResponse = await api!.fetch(
        new Request("http://localhost/tasks/sched_other_creator", {
          method: "DELETE",
        }),
        requestContext,
      );
      expect(forbiddenResponse.status).toBe(404);
      await expect(store.getTask("sched_other_creator")).resolves.toMatchObject(
        {
          status: "active",
        },
      );
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

  it("does not apply scheduler SQL migrations from package-only config", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await expect(
        migratePluginsToSql({
          pluginCatalogConfig: { packages: ["@sentry/junior-scheduler"] },
          sqlExecutor: fixture.sql,
        }),
      ).resolves.toEqual({
        existing: 0,
        migrated: 0,
        scanned: 0,
      });
    } finally {
      await fixture.close();
    }
  });

  it("applies scheduler SQL migrations from registration-only config", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await expect(
        migratePluginsToSql({
          pluginSet: defineJuniorPlugins([schedulerPlugin()]),
          sqlExecutor: fixture.sql,
        }),
      ).resolves.toEqual({
        existing: 0,
        migrated: 4,
        scanned: 4,
      });

      const db = fixture.sql.db() as unknown as SchedulerDb;
      const store = createSchedulerSqlStore(db);
      const task = createTask({ id: "sched_schema_registration_config" });
      await store.saveTask(task);
      await expect(store.getTask(task.id)).resolves.toMatchObject({
        id: task.id,
      });
    } finally {
      await fixture.close();
    }
  });

  it("does not duplicate scheduler SQL migrations for explicit registrations", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await expect(
        migratePluginsToSql({
          pluginSet: defineJuniorPlugins([
            "@sentry/junior-scheduler",
            schedulerPlugin(),
          ]),
          sqlExecutor: fixture.sql,
        }),
      ).resolves.toEqual({
        existing: 0,
        migrated: 4,
        scanned: 4,
      });
    } finally {
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
  creator_slack_user_id,
  status,
  next_run_at_ms,
  created_at_ms,
  record
) VALUES ($1, $2, $3, $4, $5, $6, $7)
`,
        [
          "sched_bad_record",
          task.destination.teamId,
          task.createdBy.slackUserId,
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
  creator_slack_user_id,
  status,
  next_run_at_ms,
  created_at_ms,
  record
) VALUES ($1, $2, $3, $4, $5, $6, $7)
`,
        [
          "sched_bad_string_record",
          task.destination.teamId,
          task.createdBy.slackUserId,
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
});
