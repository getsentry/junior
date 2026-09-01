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
import { describe, expect, it, vi } from "vitest";
import { claimDueScheduledRun } from "@/chat/scheduled-tasks/runs";
import {
  readScheduledTask as readTask,
  saveScheduledTask,
} from "@/chat/scheduled-tasks/tasks";
import type { ScheduledTask } from "@/chat/scheduled-tasks/types";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { upsertIdentity } from "@/chat/identities/sql";
import { deferred } from "../fixtures/conversation-work";
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

function readCoreMigrationJournal(): {
  entries: Array<{ idx: number; tag: string }>;
} {
  return JSON.parse(
    readFileSync(
      path.join(coreMigrationsDir(), "meta", "_journal.json"),
      "utf8",
    ),
  ) as { entries: Array<{ idx: number; tag: string }> };
}

/** Copy core migrations that predate scheduler table adoption. */
function copyPreSchedulerCoreMigrations(): string {
  const source = coreMigrationsDir();
  const destination = mkdtempSync(
    path.join(tmpdir(), "junior-pre-scheduler-core-"),
  );
  mkdirSync(path.join(destination, "meta"));
  const journal = readCoreMigrationJournal();
  const adoption = journal.entries.find((entry) => {
    const sql = readFileSync(path.join(source, `${entry.tag}.sql`), "utf8");
    return sql.includes("Adopt the former scheduler plugin tables");
  });
  if (!adoption) {
    throw new Error("Scheduler adoption migration not found");
  }
  const entries = journal.entries.filter((entry) => entry.idx < adoption.idx);
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

      await migrateSchema(fixture.sql);
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
          run_now_at_ms, created_at_ms, title, record
        ) SELECT $2, team_id, creator_slack_user_id, status, next_run_at_ms,
                 run_now_at_ms, created_at_ms, '',
                 (record - 'creatorIdentityId') || jsonb_build_object(
                   'id', $2::text,
                   'creatorIdentityId', 42,
                   'title', jsonb_build_object('invalid', true)
                 )
          FROM junior_scheduler_tasks WHERE id = $1`,
        [legacyTask.id, rollingTaskId],
      );
      const rollingTask = await readTask(fixture.sql.db(), rollingTaskId);
      expect(rollingTask).toMatchObject({
        creatorIdentityId: identity.id,
        id: rollingTaskId,
      });
      expect(rollingTask).not.toHaveProperty("title");

      const legacyTitleTaskId = `${legacyTask.id}_legacy_title`;
      await fixture.sql.execute(
        `INSERT INTO junior_scheduler_tasks (
          id, team_id, creator_slack_user_id, status, next_run_at_ms,
          run_now_at_ms, created_at_ms, title, record
        ) SELECT $2, team_id, creator_slack_user_id, status, next_run_at_ms,
                 run_now_at_ms, created_at_ms, NULL,
                 (record - 'creatorIdentityId') || jsonb_build_object(
                   'id', $2::text,
                   'title', 'Legacy null title'
                 )
          FROM junior_scheduler_tasks WHERE id = $1`,
        [legacyTask.id, legacyTitleTaskId],
      );
      await expect(
        readTask(fixture.sql.db(), legacyTitleTaskId),
      ).resolves.toMatchObject({
        creatorIdentityId: identity.id,
        id: legacyTitleTaskId,
        title: "Legacy null title",
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
      const db = fixture.sql.db();
      const task = createTask();
      await saveScheduledTask(db, task);

      await expect(readTask(db, task.id)).resolves.toMatchObject(task);
      const [first, second] = await Promise.all([
        claimDueScheduledRun(db, { nowMs: TEST_NOW_MS }),
        claimDueScheduledRun(db, { nowMs: TEST_NOW_MS }),
      ]);
      const run = first ?? second;
      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect(run).toMatchObject({
        id: `${task.id}:${TEST_RUN_AT_MS}`,
        scheduledForMs: TEST_RUN_AT_MS,
        status: "pending",
      });
      const reclaimedAtMs = TEST_NOW_MS + 60_000;
      const reclaimed = await Promise.all([
        claimDueScheduledRun(db, { nowMs: reclaimedAtMs }),
        claimDueScheduledRun(db, { nowMs: reclaimedAtMs }),
      ]);
      expect(reclaimed.filter(Boolean)).toHaveLength(1);
      expect(reclaimed.find(Boolean)).toMatchObject({
        attempt: 2,
        claimedAtMs: reclaimedAtMs,
      });
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("skips pending runs and stops claiming after a task is deleted", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      const db = fixture.sql.db();
      const task = createTask({ id: "sched_delete_stops_runs" });
      await saveScheduledTask(db, task);
      const claimed = await claimDueScheduledRun(db, { nowMs: TEST_NOW_MS });
      expect(claimed).toMatchObject({
        id: `${task.id}:${TEST_RUN_AT_MS}`,
        status: "pending",
      });

      await saveScheduledTask(db, {
        ...task,
        nextRunAtMs: undefined,
        runNowAtMs: undefined,
        status: "deleted",
        updatedAtMs: TEST_NOW_MS + 1,
      });

      const [row] = await fixture.sql.query<{
        errorMessage: string | null;
        status: string;
      }>(
        `SELECT status, record->>'errorMessage' AS "errorMessage"
         FROM junior_scheduler_runs WHERE id = $1`,
        [`${task.id}:${TEST_RUN_AT_MS}`],
      );
      expect(row).toMatchObject({
        errorMessage: `Scheduled task ${task.id} was deleted before the run started.`,
        status: "skipped",
      });
      await expect(
        claimDueScheduledRun(db, { nowMs: TEST_NOW_MS + 60_000 }),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("does not overwrite a concurrent task save while skipping missed work", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      const db = fixture.sql.db();
      const task = createTask({
        id: "sched_concurrent_missed_save",
        title: "Original title",
      });
      await saveScheduledTask(db, task);
      const missedNowMs = TEST_RUN_AT_MS + 24 * 60 * 60 * 1000 + 1;
      const savedNextRunAtMs = missedNowMs + 60_000;
      const saveCanCommit = deferred();
      const saveWritten = deferred();
      const saving = db.transaction(async (tx) => {
        await saveScheduledTask(tx, {
          ...task,
          nextRunAtMs: savedNextRunAtMs,
          title: "Concurrent edit",
          updatedAtMs: missedNowMs,
        });
        saveWritten.resolve();
        await saveCanCommit.promise;
      });
      await saveWritten.promise;

      const claiming = claimDueScheduledRun(db, { nowMs: missedNowMs });
      try {
        await vi.waitFor(
          async () => {
            const [row] = await fixture.sql.query<{ waiting: boolean }>(
              `SELECT EXISTS (
                 SELECT 1
                 FROM pg_stat_activity
                 WHERE datname = current_database()
                   AND pid <> pg_backend_pid()
                   AND wait_event_type = 'Lock'
               ) AS waiting`,
            );
            expect(row?.waiting).toBe(true);
          },
          { interval: 10, timeout: 5_000 },
        );
      } finally {
        saveCanCommit.resolve();
      }

      await saving;
      await expect(claiming).resolves.toBeUndefined();
      await expect(readTask(db, task.id)).resolves.toMatchObject({
        nextRunAtMs: savedNextRunAtMs,
        status: "active",
        title: "Concurrent edit",
        updatedAtMs: missedNowMs,
      });
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("skips malformed rows while claiming later valid work", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      const db = fixture.sql.db();
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
      await saveScheduledTask(db, task);

      await expect(readTask(db, "sched_bad_record")).resolves.toBeUndefined();
      await expect(
        claimDueScheduledRun(db, { nowMs: TEST_NOW_MS }),
      ).resolves.toMatchObject({ taskId: task.id });
    } finally {
      await fixture.close();
    }
  }, 30_000);
});
