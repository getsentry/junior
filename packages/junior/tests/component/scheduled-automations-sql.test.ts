import { describe, expect, it, vi } from "vitest";
import { claimDueScheduledRun } from "@/chat/scheduled-automations/runs";
import {
  readScheduledAutomation as readTask,
  saveScheduledAutomation,
} from "@/chat/scheduled-automations/tasks";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { upsertIdentity } from "@/chat/identities/sql";
import type { JuniorSqlExecutor } from "@/db/db";
import { deferred } from "../fixtures/conversation-work";
import { createEmptyJuniorSqlFixture } from "../fixtures/sql";

const TEST_RUN_AT_MS = Date.parse("2026-05-26T12:00:00.000Z");
const TEST_NOW_MS = Date.parse("2026-05-26T12:05:00.000Z");

/** Migrate a fresh database and store the Slack identity that creates tasks. */
async function prepareDatabase(sql: JuniorSqlExecutor): Promise<string> {
  await migrateSchema(sql);
  const identity = await upsertIdentity(sql, {
    kind: "user",
    provider: "slack",
    providerTenantId: "T123",
    providerSubjectId: "U123",
  });
  return identity.id;
}

function createTask(
  creatorIdentityId: string,
  overrides: Partial<ScheduledAutomation> = {},
): ScheduledAutomation {
  return {
    id: "sched_sql_1",
    conversationAccess: { audience: "channel", visibility: "public" },
    createdAtMs: TEST_RUN_AT_MS,
    createdBy: { slackUserId: "U123" },
    creatorIdentityId,
    credentialMode: "system",
    destination: {
      platform: "slack",
      teamId: "T123",
      channelId: "C123",
    },
    outcomes: [],
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

describe("scheduled-automation SQL storage", () => {
  it("creates and claims scheduled work from a fresh core database", async () => {
    const fixture = await createEmptyJuniorSqlFixture();

    try {
      const creatorIdentityId = await prepareDatabase(fixture.sql);
      const db = fixture.sql.db();
      const task = createTask(creatorIdentityId);
      await saveScheduledAutomation(db, task);

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
    const fixture = await createEmptyJuniorSqlFixture();

    try {
      const creatorIdentityId = await prepareDatabase(fixture.sql);
      const db = fixture.sql.db();
      const task = createTask(creatorIdentityId, {
        id: "sched_delete_stops_runs",
      });
      await saveScheduledAutomation(db, task);
      const claimed = await claimDueScheduledRun(db, { nowMs: TEST_NOW_MS });
      expect(claimed).toMatchObject({
        id: `${task.id}:${TEST_RUN_AT_MS}`,
        status: "pending",
      });

      await saveScheduledAutomation(db, {
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
        `SELECT status, error_message AS "errorMessage"
         FROM junior_automation_runs WHERE id = $1`,
        [`${task.id}:${TEST_RUN_AT_MS}`],
      );
      expect(row).toMatchObject({
        errorMessage: `Scheduled automation ${task.id} was deleted before the run started.`,
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
    const fixture = await createEmptyJuniorSqlFixture();

    try {
      const creatorIdentityId = await prepareDatabase(fixture.sql);
      const db = fixture.sql.db();
      const task = createTask(creatorIdentityId, {
        id: "sched_concurrent_missed_save",
        title: "Original title",
      });
      await saveScheduledAutomation(db, task);
      const missedNowMs = TEST_RUN_AT_MS + 24 * 60 * 60 * 1000 + 1;
      const savedNextRunAtMs = missedNowMs + 60_000;
      const saveCanCommit = deferred();
      const saveWritten = deferred();
      const saving = db.transaction(async (tx) => {
        await saveScheduledAutomation(tx, {
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
    const fixture = await createEmptyJuniorSqlFixture();

    try {
      const creatorIdentityId = await prepareDatabase(fixture.sql);
      const db = fixture.sql.db();
      const task = createTask(creatorIdentityId, {
        id: "sched_valid_after_bad_record",
      });
      await fixture.sql.execute(
        `INSERT INTO junior_automations (
          id, kind, team_id, channel_id, creator_slack_user_id,
          creator_identity_id, status, instruction, next_run_at_ms,
          created_at_ms, record
        ) VALUES ($1, 'scheduled', $2, $3, $4, $5, 'active', '', $6, $7, '{}')`,
        [
          "sched_bad_record",
          task.destination.teamId,
          task.destination.channelId,
          task.createdBy.slackUserId,
          task.creatorIdentityId,
          TEST_RUN_AT_MS,
          TEST_RUN_AT_MS - 1,
        ],
      );
      await saveScheduledAutomation(db, task);

      await expect(readTask(db, "sched_bad_record")).resolves.toBeUndefined();
      await expect(
        claimDueScheduledRun(db, { nowMs: TEST_NOW_MS }),
      ).resolves.toMatchObject({ taskId: task.id });
    } finally {
      await fixture.close();
    }
  }, 30_000);
});
