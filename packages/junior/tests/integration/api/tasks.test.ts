import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import {
  taskExecutionListSchema,
  taskListSchema,
} from "@/api/schema/task";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createEventTask, getEventTask } from "@/chat/event-tasks/store";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { createSchedulerSqlStore } from "@/chat/scheduled-tasks/store";
import type { ScheduledTask } from "@/chat/scheduled-tasks/types";
import { recordTaskExecution } from "@/chat/tasks/execution-stats";
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

  test("lists owned and public tasks but only deletes viewer-owned tasks", async () => {
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
        channelName: "project-updates",
        title: "Tasks API fixture",
        visibility: "public",
      });
      await conversationStore.recordActivity({
        conversationId: "slack:C456:tasks-api",
        actor: {
          email: "aisha@example.com",
          fullName: "Aisha Patel",
          platform: "slack",
          slackUserId: "U456",
          teamId: "T123",
        },
        channelName: "incident-response",
        destination: {
          channelId: "C456",
          platform: "slack",
          teamId: "T123",
        },
        title: "Public tasks fixture",
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
      const otherUser = await resolveViewerUserFromSql(
        fixture.sql.db(),
        "aisha@example.com",
      );
      const otherIdentity = otherUser?.identities.find(
        (candidate) =>
          candidate.provider === "slack" &&
          candidate.providerTenantId === "T123" &&
          candidate.providerSubjectId === "U456",
      );
      expect(otherIdentity).toBeDefined();

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
          description: "",
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
        task: { text: "" },
        updatedAtMs: nowMs,
      };
      const scheduledStore = createSchedulerSqlStore(fixture.sql.db());
      await scheduledStore.saveTask(scheduledTask);
      await scheduledStore.saveTask({
        ...scheduledTask,
        id: "sched_public_tasks_api",
        createdAtMs: nowMs + 2,
        createdBy: { fullName: "Aisha Patel", slackUserId: "U456" },
        creatorIdentityId: otherIdentity!.id,
        destination: {
          channelId: "C456",
          platform: "slack",
          teamId: "T123",
        },
        task: { text: "Post the public incident digest." },
        updatedAtMs: nowMs + 2,
      });
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
      await createEventTask(fixture.sql.db(), {
        id: "event_public_tasks_api",
        createdAtMs: nowMs + 3,
        createdBy: { fullName: "Aisha Patel", slackUserId: "U456" },
        credentialMode: "system",
        destination: {
          channelId: "C456",
          platform: "slack",
          teamId: "T123",
        },
        destinationVisibility: "public",
        task: { text: "Notify responders when the incident changes." },
        trigger: {
          events: ["incident.updated"],
          identifier: "INC-17",
          label: "Incident",
          namespace: "pagerduty",
          resourceType: "incident",
        },
      });
      await createEventTask(fixture.sql.db(), {
        id: "event_private_tasks_api",
        createdAtMs: nowMs + 4,
        createdBy: { fullName: "Aisha Patel", slackUserId: "U456" },
        credentialMode: "system",
        destination: {
          channelId: "CPRIVATE",
          platform: "slack",
          teamId: "T123",
        },
        destinationVisibility: "private",
        task: { text: "This private task must stay hidden." },
        trigger: {
          events: ["incident.updated"],
          identifier: "INC-PRIVATE",
          label: "Incident",
          namespace: "pagerduty",
          resourceType: "incident",
        },
      });

      for (const conversationId of [
        "agent-dispatch:sched-run-1",
        "agent-dispatch:sched-run-2",
        "agent-dispatch:event-run-1",
      ]) {
        await conversationStore.recordActivity({
          conversationId,
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
          title: "Task execution fixture",
          visibility: "public",
        });
      }

      await recordTaskExecution("scheduled", "sched_tasks_api", {
        conversationId: "agent-dispatch:sched-run-1",
        executionId: "sched-run-1",
        nowMs: Date.parse("2026-08-04T12:00:00.000Z"),
        status: "completed",
      });
      await recordTaskExecution("scheduled", "sched_tasks_api", {
        conversationId: "agent-dispatch:sched-run-2",
        executionId: "sched-run-2",
        nowMs: Date.parse("2026-08-04T13:00:00.000Z"),
        status: "failed",
      });
      await recordTaskExecution("event", "event_tasks_api", {
        conversationId: "agent-dispatch:event-run-1",
        executionId: "event-run-1",
        nowMs: Date.parse("2026-08-03T12:00:00.000Z"),
        status: "completed",
      });
      await recordTaskExecution("scheduled", "sched_tasks_api", {
        conversationId: "agent-dispatch:sched-run-2",
        executionId: "sched-run-2",
        nowMs: Date.parse("2026-08-04T13:00:00.000Z"),
        status: "failed",
      });

      const response = await authenticatedApi("VIEWER@example.com").request(
        "http://localhost/api/tasks",
      );
      expect(response.status).toBe(200);
      expect(taskListSchema.parse(await response.json())).toEqual({
        executionDays: expect.any(Array),
        tasks: [
          expect.objectContaining({
            createdBy: "Aisha Patel",
            createdByEmail: "aisha@example.com",
            destination: expect.objectContaining({
              label: "#incident-response",
              visibility: "public",
            }),
            id: "event_public_tasks_api",
            kind: "event",
            ownedByViewer: false,
            source: "pagerduty",
          }),
          expect.objectContaining({
            createdBy: "Aisha Patel",
            createdByEmail: "aisha@example.com",
            destination: expect.objectContaining({
              label: "#incident-response",
              visibility: "public",
            }),
            id: "sched_public_tasks_api",
            schedule: "Schedule unavailable",
            kind: "scheduled",
            ownedByViewer: false,
          }),
          expect.objectContaining({
            createdByEmail: "viewer@example.com",
            id: "event_tasks_api",
            kind: "event",
            lastConversationId: "agent-dispatch:event-run-1",
            lastRunAt: "2026-08-03T12:00:00.000Z",
            ownedByViewer: true,
            runsLast7Days: 1,
            source: "linear",
            totalRuns: 1,
            triggerAvailable: false,
          }),
          expect.objectContaining({
            createdByEmail: "viewer@example.com",
            destination: expect.objectContaining({
              label: "#project-updates",
            }),
            id: "sched_tasks_api",
            instruction: "Untitled scheduled task",
            kind: "scheduled",
            lastConversationId: "agent-dispatch:sched-run-2",
            lastRunAt: "2026-08-04T13:00:00.000Z",
            ownedByViewer: true,
            runsLast7Days: 2,
            schedule: "Schedule unavailable",
            status: "active",
            title: "Untitled scheduled task",
            totalRuns: 2,
          }),
        ],
        truncated: false,
      });

      const executionsResponse = await authenticatedApi(
        "viewer@example.com",
      ).request(
        "http://localhost/api/tasks/scheduled/sched_tasks_api/executions",
      );
      expect(executionsResponse.status).toBe(200);
      const executionList = taskExecutionListSchema.parse(
        await executionsResponse.json(),
      );
      expect(executionList).toEqual({
        executionDays: expect.any(Array),
        executions: [
          {
            conversationId: "agent-dispatch:sched-run-2",
            executedAt: "2026-08-04T13:00:00.000Z",
            executionId: "sched-run-2",
            status: "failed",
            title: "Task execution fixture",
          },
          {
            conversationId: "agent-dispatch:sched-run-1",
            executedAt: "2026-08-04T12:00:00.000Z",
            executionId: "sched-run-1",
            status: "completed",
            title: "Task execution fixture",
          },
        ],
        task: expect.objectContaining({
          id: "sched_tasks_api",
          kind: "scheduled",
          totalRuns: 2,
        }),
        truncated: false,
      });
      expect(executionList.executionDays).toHaveLength(90);
      expect(
        executionList.executionDays.find((day) => day.date === "2026-08-04"),
      ).toEqual({
        blocked: 0,
        completed: 1,
        date: "2026-08-04",
        failed: 1,
      });

      const deniedExecutions = await authenticatedApi(
        "viewer@example.com",
      ).request(
        "http://localhost/api/tasks/event/event_private_tasks_api/executions",
      );
      expect(deniedExecutions.status).toBe(404);

      for (let index = 0; index <= 100; index += 1) {
        await scheduledStore.saveTask({
          ...scheduledTask,
          id: `sched_public_crowding_${index}`,
          createdAtMs: nowMs + 1_000 + index,
          createdBy: { fullName: "Aisha Patel", slackUserId: "U456" },
          creatorIdentityId: otherIdentity!.id,
          destination: {
            channelId: "C456",
            platform: "slack",
            teamId: "T123",
          },
          task: { text: `Public crowding task ${index}.` },
          updatedAtMs: nowMs + 1_000 + index,
        });
      }
      const crowdedResponse = await authenticatedApi(
        "viewer@example.com",
      ).request("http://localhost/api/tasks");
      expect(crowdedResponse.status).toBe(200);
      const crowdedList = taskListSchema.parse(await crowdedResponse.json());
      expect(crowdedList.executionDays).toHaveLength(90);
      expect(crowdedList.tasks).toHaveLength(102);
      expect(
        crowdedList.tasks
          .filter((task) => task.ownedByViewer)
          .map((task) => task.id),
      ).toEqual(["event_tasks_api", "sched_tasks_api"]);
      expect(crowdedList.truncated).toBe(true);

      await conversationStore.recordActivity({
        conversationId: "slack:C456:tasks-api-private",
        actor: {
          email: "aisha@example.com",
          fullName: "Aisha Patel",
          platform: "slack",
          slackUserId: "U456",
          teamId: "T123",
        },
        channelName: "incident-response",
        destination: {
          channelId: "C456",
          platform: "slack",
          teamId: "T123",
        },
        title: "Private tasks fixture",
        visibility: "private",
      });
      const privateResponse = await authenticatedApi(
        "viewer@example.com",
      ).request("http://localhost/api/tasks");
      expect(privateResponse.status).toBe(200);
      const privateList = taskListSchema.parse(await privateResponse.json());
      expect(privateList.executionDays).toHaveLength(90);
      expect(privateList.tasks.map((task) => task.id)).toEqual([
        "event_tasks_api",
        "sched_tasks_api",
      ]);
      expect(privateList.tasks.every((task) => task.ownedByViewer)).toBe(true);

      const deniedPublicDelete = await authenticatedApi(
        "viewer@example.com",
      ).request("http://localhost/api/tasks/event/event_public_tasks_api", {
        method: "DELETE",
      });
      expect(deniedPublicDelete.status).toBe(404);

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
