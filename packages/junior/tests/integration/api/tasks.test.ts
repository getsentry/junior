import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { taskListSchema } from "@/api/schema/task";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createEventTask, getEventTask } from "@/chat/event-tasks/store";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { createSchedulerSqlStore } from "@/chat/scheduled-tasks/store";
import type { ScheduledTask } from "@/chat/scheduled-tasks/types";
import { createConfiguredJuniorSqlFixture } from "../../fixtures/sql";

function authenticatedApi(email: string) {
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("verifiedViewerEmail", email);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

describe("Tasks API", () => {
  test("requires an authenticated viewer", async () => {
    const response = await createJuniorApi().request(
      "http://localhost/api/tasks",
    );
    expect(response.status).toBe(401);
  });

  test("lists and deletes viewer-owned scheduled and event tasks", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const conversationStore = createSqlStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      await conversationStore.recordActivity({
        conversationId: "slack:C123:tasks-api",
        actor: {
          email: "viewer@example.com",
          platform: "slack",
          slackUserId: "U123",
          teamId: "T123",
        },
        destination: {
          channelId: "C123",
          platform: "slack",
          teamId: "T123",
        },
        title: "Tasks API fixture",
        visibility: "public",
      });
      const user = await resolveViewerUserFromSql(
        fixture.sql.db(),
        "viewer@example.com",
      );
      const identity = user?.identities.find(
        (candidate) =>
          candidate.provider === "slack" &&
          candidate.providerTenantId === "T123" &&
          candidate.providerSubjectId === "U123",
      );
      expect(identity).toBeDefined();

      const nowMs = Date.parse("2026-08-03T12:00:00.000Z");
      const scheduledTask: ScheduledTask = {
        id: "sched_tasks_api",
        conversationAccess: { audience: "channel", visibility: "public" },
        createdAtMs: nowMs,
        createdBy: { slackUserId: "U123" },
        creatorIdentityId: identity!.id,
        credentialMode: "creator",
        destination: {
          channelId: "C123",
          platform: "slack",
          teamId: "T123",
        },
        nextRunAtMs: nowMs + 60_000,
        schedule: {
          description: "Daily at noon",
          kind: "recurring",
          recurrence: {
            frequency: "daily",
            interval: 1,
            startDate: "2026-08-03",
            time: { hour: 12, minute: 0 },
          },
          timezone: "UTC",
        },
        status: "active",
        task: { text: "Post the daily digest." },
        updatedAtMs: nowMs,
      };
      const scheduledStore = createSchedulerSqlStore(fixture.sql.db());
      await scheduledStore.saveTask(scheduledTask);
      await createEventTask(fixture.sql.db(), {
        id: "event_tasks_api",
        createdAtMs: nowMs + 1,
        createdBy: { slackUserId: "U123" },
        credentialMode: "system",
        destination: {
          channelId: "C123",
          platform: "slack",
          teamId: "T123",
        },
        destinationVisibility: "public",
        task: { text: "Summarize the closed issue." },
        trigger: {
          events: ["issue.closed"],
          identifier: "ACME-42",
          label: "Issue",
          namespace: "linear",
          resourceType: "issue",
        },
      });

      const response = await authenticatedApi("VIEWER@example.com").request(
        "http://localhost/api/tasks",
      );
      expect(response.status).toBe(200);
      expect(taskListSchema.parse(await response.json())).toEqual({
        tasks: [
          expect.objectContaining({
            id: "event_tasks_api",
            kind: "event",
            triggerAvailable: false,
          }),
          expect.objectContaining({
            id: "sched_tasks_api",
            kind: "scheduled",
            status: "active",
          }),
        ],
        truncated: false,
      });

      const deletedScheduled = await authenticatedApi(
        "viewer@example.com",
      ).request("http://localhost/api/tasks/scheduled/sched_tasks_api", {
        method: "DELETE",
      });
      expect(deletedScheduled.status).toBe(204);
      await expect(
        scheduledStore.getTask("sched_tasks_api"),
      ).resolves.toMatchObject({ status: "deleted" });

      const deletedEvent = await authenticatedApi("viewer@example.com").request(
        "http://localhost/api/tasks/event/event_tasks_api",
        { method: "DELETE" },
      );
      expect(deletedEvent.status).toBe(204);
      await expect(
        getEventTask(fixture.sql.db(), "event_tasks_api"),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.close();
    }
  }, 30_000);
});
