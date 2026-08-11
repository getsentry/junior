import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  createSchedulerSqlStore,
  type ScheduledTask,
  type SchedulerDb,
} from "@/chat/scheduled-tasks";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { upsertIdentity } from "@/chat/identities/sql";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

const TEST_RUN_AT_MS = Date.parse("2026-05-26T12:00:00.000Z");
const TEST_NOW_MS = Date.parse("2026-05-26T12:05:00.000Z");

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "sched_sql_1",
    conversationAccess: { audience: "channel", visibility: "public" },
    createdAtMs: TEST_RUN_AT_MS,
    createdBy: { slackUserId: "U123" },
    creatorIdentityId: "identity-viewer",
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
    task: { text: "Post a digest." },
    updatedAtMs: TEST_RUN_AT_MS,
    ...overrides,
  };
}

function coreMigrationsDir(): string {
  return path.resolve(process.cwd(), "migrations");
}

function copyPreSchedulerCoreMigrations(): string {
  const source = coreMigrationsDir();
  const destination = mkdtempSync(
    path.join(tmpdir(), "junior-pre-scheduler-core-"),
  );
  mkdirSync(path.join(destination, "meta"));
  const journal = JSON.parse(
    readFileSync(path.join(source, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const entries = journal.entries.filter((entry) => entry.idx < 16);
  writeFileSync(
    path.join(destination, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries) {
    copyFileSync(
      path.join(source, `${entry.tag}.sql`),
      path.join(destination, `${entry.tag}.sql`),
    );
  }
  return destination;
}

async function createLegacySchedulerTables(
  fixture: Awaited<ReturnType<typeof createLocalJuniorSqlFixture>>,
): Promise<void> {
  await fixture.sql.execute(`
CREATE TABLE junior_scheduler_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  team_id TEXT NOT NULL,
  status TEXT NOT NULL,
  next_run_at_ms BIGINT,
  run_now_at_ms BIGINT,
  created_at_ms BIGINT NOT NULL,
  record JSONB NOT NULL
);
CREATE TABLE junior_scheduler_runs (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  scheduled_for_ms BIGINT NOT NULL,
  record JSONB NOT NULL
)
`);
}

describe("scheduled-task SQL storage", () => {
  it("adopts deployed Scheduler rows into the core schema", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const oldCoreMigrations = copyPreSchedulerCoreMigrations();

    try {
      await fixture.sql.migrate({
        migrationsFolder: oldCoreMigrations,
        migrationsTable: "__drizzle_junior_core",
      });
      await createLegacySchedulerTables(fixture);
      await fixture.sql.execute(
        `INSERT INTO junior_destinations (
          id, provider, provider_tenant_id, provider_destination_id,
          kind, visibility, created_at, updated_at
        ) VALUES ($1, 'slack', $2, $3, 'channel', 'public', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        ["destination_scheduler_public", "T123", "C123"],
      );
      const identity = await upsertIdentity(fixture.sql, {
        email: "person@example.com",
        emailVerified: true,
        kind: "user",
        provider: "slack",
        providerSubjectId: "U123",
        providerTenantId: "T123",
      });
      const currentTask = createTask({ id: "sched_legacy" });
      const {
        conversationAccess: _conversationAccess,
        credentialMode: _credentialMode,
        creatorIdentityId: _creatorIdentityId,
        ...legacyTask
      } = currentTask;
      await fixture.sql.execute(
        `INSERT INTO junior_scheduler_tasks (
          id, team_id, status, next_run_at_ms, created_at_ms, record
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
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
            },
          }),
        ],
      );
      const pausedTaskId = "sched_paused_legacy";
      await fixture.sql.execute(
        `INSERT INTO junior_scheduler_tasks (
          id, team_id, status, next_run_at_ms, created_at_ms, record
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          pausedTaskId,
          legacyTask.destination.teamId,
          "paused",
          null,
          legacyTask.createdAtMs,
          JSON.stringify({
            ...legacyTask,
            id: pausedTaskId,
            nextRunAtMs: undefined,
            status: "paused",
            credentialSubject: {
              type: "user",
              userId: "slack:T123:U123",
            },
          }),
        ],
      );

      await expect(migrateSchema(fixture.sql)).resolves.toMatchObject({
        existing: 16,
        migrated: 10,
      });
      const [migrated] = await fixture.sql.query<{
        creatorIdentityId: string | null;
        creatorSlackUserId: string | null;
        record: Record<string, unknown>;
      }>(
        `SELECT creator_identity_id AS "creatorIdentityId",
                creator_slack_user_id AS "creatorSlackUserId", record
         FROM junior_scheduler_tasks WHERE id = $1`,
        [legacyTask.id],
      );
      expect(migrated).toMatchObject({
        creatorIdentityId: identity.id,
        creatorSlackUserId: "U123",
        record: {
          conversationAccess: {
            audience: "channel",
            visibility: "public",
          },
          credentialMode: "system",
          creatorIdentityId: identity.id,
        },
      });
      expect(migrated?.record).not.toHaveProperty("credentialSubject");

      const [paused] = await fixture.sql.query<{
        nextRunAtMs: number | null;
        record: Record<string, unknown>;
        status: string;
      }>(
        `SELECT status,
                next_run_at_ms AS "nextRunAtMs",
                record
         FROM junior_scheduler_tasks WHERE id = $1`,
        [pausedTaskId],
      );
      expect(paused).toMatchObject({
        nextRunAtMs: null,
        status: "deleted",
        record: {
          status: "deleted",
        },
      });
      expect(paused?.record).not.toHaveProperty("nextRunAtMs");
      expect(paused?.record).not.toHaveProperty("runNowAtMs");

      const rollingTaskId = `${legacyTask.id}_rolling`;
      await fixture.sql.execute(
        `INSERT INTO junior_scheduler_tasks (
          id, team_id, creator_slack_user_id, status, next_run_at_ms,
          run_now_at_ms, created_at_ms, record
        ) SELECT $2, team_id, creator_slack_user_id, status, next_run_at_ms,
                 run_now_at_ms, created_at_ms,
                 (record - 'creatorIdentityId') || jsonb_build_object('id', $2::text)
          FROM junior_scheduler_tasks WHERE id = $1`,
        [legacyTask.id, rollingTaskId],
      );
      const store = createSchedulerSqlStore(
        fixture.sql.db() as unknown as SchedulerDb,
      );
      await expect(store.getTask(rollingTaskId)).resolves.toMatchObject({
        creatorIdentityId: identity.id,
        id: rollingTaskId,
      });
    } finally {
      rmSync(oldCoreMigrations, { force: true, recursive: true });
      await fixture.close();
    }
  }, 30_000);

  it("creates and claims scheduled work from a fresh core database", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      const store = createSchedulerSqlStore(
        fixture.sql.db() as unknown as SchedulerDb,
      );
      const task = createTask();
      await store.saveTask(task);

      await expect(store.getTask(task.id)).resolves.toMatchObject(task);
      const run = await store.claimDueRun({ nowMs: TEST_NOW_MS });
      expect(run).toMatchObject({
        id: `${task.id}:${TEST_RUN_AT_MS}`,
        scheduledForMs: TEST_RUN_AT_MS,
        status: "pending",
      });
      await expect(store.claimDueRun({ nowMs: TEST_NOW_MS })).resolves.toBe(
        undefined,
      );
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("skips malformed rows while claiming later valid work", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      const store = createSchedulerSqlStore(
        fixture.sql.db() as unknown as SchedulerDb,
      );
      const task = createTask({ id: "sched_valid_after_bad_record" });
      await fixture.sql.execute(
        `INSERT INTO junior_scheduler_tasks (
          id, team_id, creator_identity_id, creator_slack_user_id, status,
          next_run_at_ms, created_at_ms, record
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          "sched_bad_record",
          task.destination.teamId,
          task.creatorIdentityId,
          task.createdBy.slackUserId,
          "active",
          TEST_RUN_AT_MS,
          TEST_RUN_AT_MS - 1,
          JSON.stringify({ id: "sched_bad_record" }),
        ],
      );
      await store.saveTask(task);

      await expect(store.getTask("sched_bad_record")).resolves.toBeUndefined();
      await expect(
        store.claimDueRun({ nowMs: TEST_NOW_MS }),
      ).resolves.toMatchObject({ taskId: task.id });
    } finally {
      await fixture.close();
    }
  }, 30_000);
});
