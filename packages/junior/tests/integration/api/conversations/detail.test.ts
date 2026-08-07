import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { conversationDetailReportSchema } from "@/api/schema";
import {
  closeDb,
  getDb,
  getConversationEventStore,
  getConversationStore,
} from "@/chat/db";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { readConversationDetail } from "@/api/conversations/detail";

describe("conversation detail API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("returns newly appended events when refreshed", async () => {
    const conversationId = "internal:refreshed-detail";
    await getConversationStore().recordActivity({
      conversationId,
      nowMs: 1,
      source: "internal",
      title: "Refreshed conversation",
    });

    const app = createJuniorApi();
    const detailResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}`,
    );
    const detail = conversationDetailReportSchema.parse(
      await detailResponse.json(),
    );
    expect(detail.events).toEqual([]);

    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: 2,
        data: {
          messageId: "first-message",
          role: "assistant",
          text: "first-message",
          type: "message",
        },
      },
      {
        createdAtMs: 3,
        data: {
          content: { costUsd: 0.0004, memories: [] },
          name: "memories_recalled",
          namespace: "memory",
          type: "structured_event",
          version: 1,
        },
      },
    ]);
    const refreshedResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}`,
    );
    const refreshed = conversationDetailReportSchema.parse(
      await refreshedResponse.json(),
    );
    expect(refreshed.events.map((event) => event.seq)).toEqual([0]);
    expect(refreshed.auxiliaryCosts).toEqual({
      costUsd: 0.0004,
      operations: [
        {
          costUsd: 0.0004,
          events: 1,
          name: "memories_recalled",
          namespace: "memory",
        },
      ],
    });
  });

  it("only returns annotations to viewers with private-content access", async () => {
    const conversationId = "slack:C-private:annotated-detail";
    await getConversationStore().recordActivity({
      actor: {
        email: "Participant@Example.com",
        platform: "slack",
        slackUserId: "U-participant",
        teamId: "TPRIVATE",
      },
      conversationId,
      destination: {
        channelId: "CPRIVATE",
        platform: "slack",
        teamId: "TPRIVATE",
      },
      nowMs: 1,
      source: "slack",
      title: "Private annotated conversation",
      visibility: "private",
    });
    const annotations = createPluginAnnotations({
      conversationId,
      db: getDb(),
      plugin: "github",
    });
    await annotations.upsert({
      kind: "resource_link",
      key: "getsentry/junior#1081",
      label: "getsentry/junior #1081",
      status: "open",
      url: "https://github.com/getsentry/junior/pull/1081",
    });

    await expect(readConversationDetail(conversationId)).resolves.toMatchObject(
      {
        annotations: [],
        eventHistory: { status: "redacted" },
      },
    );
    await expect(
      readConversationDetail(conversationId, {
        verifiedViewerEmail: "participant@example.com",
      }),
    ).resolves.toMatchObject({
      annotations: [
        {
          key: "getsentry/junior#1081",
          kind: "resource_link",
          label: "getsentry/junior #1081",
          plugin: "github",
          status: "open",
          url: "https://github.com/getsentry/junior/pull/1081",
        },
      ],
      eventHistory: { status: "available" },
    });
  });

  it("links a viewer-visible source task from a terminal execution", async () => {
    const { createConfiguredJuniorSqlFixture } = await import(
      "../../../fixtures/sql"
    );
    const { migrateSchema } = await import(
      "@/chat/conversations/sql/migrations"
    );
    const { createSqlStore } = await import("@/chat/conversations/sql/store");
    const { resolveViewerUserFromSql } = await import("@/chat/plugins/viewer");
    const { createSchedulerSqlStore } = await import(
      "@/chat/scheduled-tasks/store"
    );
    const { recordTaskExecution } = await import(
      "@/chat/tasks/execution-stats"
    );
    const fixture = createConfiguredJuniorSqlFixture();
    const conversationStore = createSqlStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      const conversationId = "agent-dispatch:source-task-detail";
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
        channelName: "project-updates",
        nowMs: 1,
        source: "scheduler",
        title: "Weekly project summary run",
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
      const nowMs = 2;
      await createSchedulerSqlStore(fixture.sql.db()).saveTask({
        id: "sched_source_task",
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
          description: "Every Monday at 9:00 AM",
          kind: "recurring",
          recurrence: {
            frequency: "weekly",
            interval: 1,
            startDate: "2026-08-03",
            time: { hour: 9, minute: 0 },
            weekdays: [1],
          },
          timezone: "UTC",
        },
        status: "active",
        task: { text: "Send the weekly project summary" },
        updatedAtMs: nowMs,
      });
      await recordTaskExecution("scheduled", "sched_source_task", {
        conversationId,
        executionId: "run_source_task",
        nowMs: nowMs + 1,
        status: "completed",
      });

      await expect(
        readConversationDetail(conversationId, {
          verifiedViewerEmail: "viewer@example.com",
        }),
      ).resolves.toMatchObject({
        sourceTask: {
          id: "sched_source_task",
          kind: "scheduled",
          label: "Send the weekly project summary",
        },
      });
      await expect(
        readConversationDetail(conversationId),
      ).resolves.toMatchObject({
        sourceTask: { kind: "scheduled" },
      });
      const hidden = await readConversationDetail(conversationId);
      expect(hidden?.sourceTask).not.toHaveProperty("id");
      expect(hidden?.sourceTask).not.toHaveProperty("label");
    } finally {
      await fixture.close();
    }
  });
});
