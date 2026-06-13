import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSchedulerSqlStore,
  createSchedulerStore,
  schedulerPlugin,
  type ScheduledTask,
} from "@sentry/junior-scheduler";
import { defineJuniorPlugins } from "@/plugins";
import {
  createPluginDbForExecutor,
  migratePluginSchemas,
  readPluginMigrations,
} from "@/chat/plugins/db";
import { createPluginState } from "@/chat/plugins/state";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { runPluginStorageMigrations } from "@/cli/upgrade/migrations/plugin-storage";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

const TEST_RUN_AT_MS = Date.parse("2026-05-26T12:00:00.000Z");
const TEST_NOW_MS = Date.parse("2026-05-26T12:05:00.000Z");

function schedulerMigrationsDir(): string {
  return path.resolve(process.cwd(), "../junior-scheduler/migrations");
}

async function migrateSchedulerSchema(
  fixture: Awaited<ReturnType<typeof createLocalJuniorSqlFixture>>,
) {
  await migratePluginSchemas(
    fixture.executor,
    readPluginMigrations({
      dir: schedulerMigrationsDir(),
      pluginName: "scheduler",
    }),
  );
}

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "sched_sql_1",
    createdAtMs: TEST_RUN_AT_MS,
    createdBy: { slackUserId: "U123" },
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
    version: 1,
    ...overrides,
  };
}

describe("scheduler SQL plugin storage", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("persists and claims scheduled runs through the plugin SQL database", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchedulerSchema(fixture);
      const db = createPluginDbForExecutor(fixture.executor);
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

  it("migrates existing scheduler plugin state into SQL idempotently", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchedulerSchema(fixture);
      const db = createPluginDbForExecutor(fixture.executor);
      const stateStore = createSchedulerStore(createPluginState("scheduler"));
      const task = createTask({ id: "sched_state_sql" });
      await stateStore.saveTask(task);
      const run = await stateStore.claimDueRun({ nowMs: TEST_NOW_MS });
      expect(run).toBeDefined();

      const context = {
        io: { info: () => {} },
        pluginDb: db,
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
      await fixture.close();
    }
  }, 15_000);
});
