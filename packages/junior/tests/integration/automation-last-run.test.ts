import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { recordAutomationExecution } from "@/chat/automations/execution-stats";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { saveScheduledAutomation } from "@/chat/scheduled-automations/tasks";
import { juniorAutomationRuns } from "@/db/schema/automation-runs";
import { juniorAutomations } from "@/db/schema/automations";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

describe("Automation last run", () => {
  test("a run outcome and the last run pointer commit together", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const destination = {
        channelId: "C123",
        platform: "slack" as const,
        teamId: "T123",
      };
      await createSqlStore(fixture.sql).recordActivity({
        actor: {
          email: "viewer@example.com",
          platform: "slack",
          slackUserId: "U123",
          teamId: "T123",
        },
        conversationId: "slack:C123:last-run",
        destination,
        title: "Seed",
        visibility: "public",
      });
      const user = await resolveViewerUserFromSql(
        fixture.sql.db(),
        "viewer@example.com",
      );
      const nowMs = Date.now();
      await saveScheduledAutomation(fixture.sql.db(), {
        id: "sched_last_run",
        conversationAccess: { audience: "channel", visibility: "public" },
        createdAtMs: nowMs - 60_000,
        createdBy: { slackUserId: "U123" },
        creatorIdentityId: user!.identities.find(
          (identity) => identity.provider === "slack",
        )!.id,
        credentialMode: "creator",
        destination,
        nextRunAtMs: nowMs + 60_000,
        outcomes: [],
        schedule: {
          description: "",
          kind: "recurring",
          recurrence: {
            frequency: "daily",
            interval: 1,
            startDate: new Date(nowMs).toISOString().slice(0, 10),
            time: { hour: 12, minute: 0 },
          },
          timezone: "UTC",
        },
        status: "active",
        task: { kind: "instruction", instruction: "Post the daily digest." },
        updatedAtMs: nowMs,
      });
      const state = async () => {
        const db = fixture.sql.db();
        const [automation] = await db
          .select({ lastRunId: juniorAutomations.lastRunId })
          .from(juniorAutomations)
          .where(eq(juniorAutomations.id, "sched_last_run"));
        const runs = await db
          .select({ id: juniorAutomationRuns.id })
          .from(juniorAutomationRuns)
          .where(eq(juniorAutomationRuns.automationId, "sched_last_run"));
        return {
          lastRunId: automation!.lastRunId,
          runs: runs.map((run) => run.id),
        };
      };
      const record = async () =>
        await recordAutomationExecution("sched_last_run", {
          executionId: "run-1",
          nowMs,
          status: "failed",
        });

      // A failed pointer update leaves no run that the list cannot see.
      await fixture.sql.query(
        `create function fail_last_run() returns trigger language plpgsql as $$ begin raise exception 'last run write failed'; end $$`,
      );
      await fixture.sql.query(
        `create trigger fail_last_run before update of last_run_id on junior_automations for each row execute function fail_last_run()`,
      );
      await record();
      expect(await state()).toEqual({ lastRunId: null, runs: [] });

      // The retry stores both.
      await fixture.sql.query(
        `drop trigger fail_last_run on junior_automations`,
      );
      await record();
      expect(await state()).toEqual({ lastRunId: "run-1", runs: ["run-1"] });
    } finally {
      await fixture.close();
    }
  });
});
