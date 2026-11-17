import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { conversationUsageCostExpr } from "@/api/conversations/aggregate";
import type { JuniorApiEnv } from "@/api/route";
import {
  automationExecutionListSchema,
  automationSummarySchema,
} from "@/api/schema/automation";
import { recordAutomationExecution } from "@/chat/automations/execution-stats";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import {
  resolveViewerUser,
  resolveViewerUserFromSql,
} from "@/chat/plugins/viewer";
import { saveScheduledAutomation } from "@/chat/scheduled-automations/tasks";
import { juniorAutomationRuns } from "@/db/schema/automation-runs";
import { juniorConversations } from "@/db/schema/conversations";
import { createConfiguredJuniorSqlFixture } from "../../fixtures/sql";
import { expectSqlBudget } from "../../fixtures/sql-budget";

function authenticatedApi(email: string) {
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    const viewer = await resolveViewerUser(email);
    if (!viewer) throw new Error(`missing viewer for ${email}`);
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

describe("Automation run cost", () => {
  test("follows usage that a run's Conversation gains after the run", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const conversationStore = createSqlStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      const actor = {
        email: "viewer@example.com",
        platform: "slack" as const,
        slackUserId: "U123",
        teamId: "T123",
      };
      const destination = {
        channelId: "C123",
        platform: "slack" as const,
        teamId: "T123",
      };
      const runConversationId = "agent-dispatch:cost-run";
      await conversationStore.recordActivity({
        actor,
        conversationId: runConversationId,
        destination,
        title: "Automation run",
        visibility: "public",
      });
      const user = await resolveViewerUserFromSql(
        fixture.sql.db(),
        "viewer@example.com",
      );
      const identity = user!.identities.find(
        (candidate) => candidate.provider === "slack",
      )!;
      const nowMs = Date.now();
      const runAtMs = nowMs - 60 * 60 * 1000;
      await saveScheduledAutomation(fixture.sql.db(), {
        id: "sched_cost",
        conversationAccess: { audience: "channel", visibility: "public" },
        createdAtMs: nowMs - 2 * 60 * 60 * 1000,
        createdBy: { slackUserId: "U123" },
        creatorIdentityId: identity.id,
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
      const recordTurn = async (runId: string, costUsd: number) =>
        await conversationStore.recordExecution({
          conversationId: runConversationId,
          createdAtMs: runAtMs,
          execution: { runId, status: "idle", updatedAtMs: Date.now() },
          lastActivityAtMs: Date.now(),
          metrics: {
            durationMs: 1_000,
            usage: { cost: { total: costUsd }, totalTokens: 100 },
          },
          updatedAtMs: Date.now(),
        });
      const api = authenticatedApi("viewer@example.com");
      const readCost = async () => {
        const summary = automationSummarySchema.parse(
          await (
            await api.request("http://localhost/api/automations/sched_cost")
          ).json(),
        );
        const executions = automationExecutionListSchema.parse(
          await (
            await api.request(
              "http://localhost/api/automations/sched_cost/executions",
            )
          ).json(),
        );
        const day = new Date(runAtMs).toISOString().slice(0, 10);
        return {
          day: executions.executionDays.find((entry) => entry.date === day)
            ?.costUsd,
          total: summary.totalCostUsd,
          week: summary.costUsd[7],
        };
      };

      // The run's Turn writes usage before the run records its outcome.
      await recordTurn("turn-1", 0.2);
      await recordAutomationExecution("sched_cost", {
        conversationId: runConversationId,
        executionId: "cost-run",
        nowMs: runAtMs,
        status: "completed",
      });
      expect(await readCost()).toEqual({ day: 0.2, total: 0.2, week: 0.2 });

      // A follow-up Turn in the run's Conversation adds usage later.
      // The usage update carries the copy to the run: a separate copy
      // statement goes over this budget.
      await expectSqlBudget(() => recordTurn("turn-2", 0.05), {
        statements: 18,
        serialRounds: 18,
      });
      expect(await readCost()).toEqual({ day: 0.25, total: 0.25, week: 0.25 });

      // Each stored run cost equals the cost of its Conversation.
      const [parity] = await fixture.sql
        .db()
        .select({
          conversation: conversationUsageCostExpr(juniorConversations.usage),
          run: juniorAutomationRuns.costUsd,
        })
        .from(juniorAutomationRuns)
        .innerJoin(
          juniorConversations,
          eq(
            juniorConversations.conversationId,
            juniorAutomationRuns.conversationId,
          ),
        )
        .where(eq(juniorAutomationRuns.id, "cost-run"));
      expect(parity!.run).toBe(parity!.conversation);
    } finally {
      await fixture.close();
    }
  });
});
