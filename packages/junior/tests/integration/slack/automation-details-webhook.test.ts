import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { recordAutomationExecution } from "@/chat/automations/execution-stats";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { createEventAutomation } from "@/chat/event-automations/store";
import { upsertIdentity } from "@/chat/identities/sql";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { saveScheduledAutomation } from "@/chat/scheduled-automations/tasks";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
} from "../../fixtures/conversation-work";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";
import { resetSlackApiMockState } from "../../msw/handlers/slack-api";

const SIGNING_SECRET = "test-signing-secret";
const ORIGINAL_ENV = { ...process.env };

async function requestDetails(
  id: string,
  user = "U123",
  teamId = "T123",
  type = "automation",
  coordinates: {
    channel?: string;
    message_ts?: string;
    thread_ts?: string;
  } = {},
) {
  const client = createSlackWebhookTestClient({
    signingSecret: SIGNING_SECRET,
  });
  const waitUntil = client.waitUntil();
  const queue = createConversationWorkQueueTestAdapter();
  const response = await handleSlackWebhook({
    request: client.event({
      type: "event_callback",
      team_id: teamId,
      event: {
        type: "entity_details_requested",
        user,
        external_ref: { id, type },
        trigger_id: `trigger-${id}`,
        // The URL must not select an object or grant access.
        entity_url: "https://untrusted.example/automations/other",
        channel: "C123",
        ...coordinates,
      },
    }),
    waitUntil: waitUntil.fn,
    services: {
      getSlackAdapter: () =>
        createJuniorSlackAdapter({
          botToken: "xoxb-test-token",
          botUserId: "U0BOT",
          signingSecret: SIGNING_SECRET,
        }),
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      state: createMemoryState(),
    },
  });
  expect(response.status).toBe(200);
  await waitUntil.flush();
  expect(queue.sentRecords()).toEqual([]);
  expect(slackApiOutbox.messages()).toEqual([]);
  return slackApiOutbox.calls("entity.presentDetails").at(-1)?.params;
}

async function saveReminder(): Promise<ScheduledAutomation> {
  const identity = await upsertIdentity(getSqlExecutor(), {
    kind: "user",
    provider: "slack",
    providerTenantId: "T123",
    providerSubjectId: "U123",
    email: "owner@example.com",
    emailVerified: true,
  });
  const task: ScheduledAutomation = {
    id: "sched_reminder",
    title: "Water reminder",
    createdBy: { slackUserId: "U123", fullName: "Reminder owner" },
    creatorIdentityId: identity.id,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    credentialMode: "creator",
    destination: { platform: "slack", teamId: "T123", channelId: "D123" },
    conversationAccess: { audience: "direct", visibility: "private" },
    outcomes: [],
    schedule: {
      kind: "recurring",
      description: "Every day at noon",
      timezone: "UTC",
      recurrence: {
        frequency: "daily",
        interval: 1,
        startDate: "2026-09-23",
        time: { hour: 12, minute: 0 },
      },
    },
    status: "active",
    nextRunAtMs: Date.now() + 86_400_000,
    task: {
      text: "Remind me to drink water.\n\n- Keep the reminder brief.\n- Include **one** useful tip.",
    },
  };
  await saveScheduledAutomation(getDb(), task);
  return task;
}

describe("Slack Work Object details", () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
    });
    resetSlackApiMockState();
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    setDashboardConversationLinkOptions(undefined);
    resetSlackApiMockState();
    await disconnectStateAdapter();
  });

  it("shows saved annotation facts only within the viewer's Conversation access", async () => {
    await saveReminder();
    const conversationId = "slack:D123:1700000000.000001";
    await getConversationStore().recordActivity({
      conversationId,
      actor: { platform: "slack", teamId: "T123", slackUserId: "U123" },
      destination: { platform: "slack", teamId: "T123", channelId: "D123" },
      visibility: "private",
    });
    await createPluginAnnotations({
      conversationId,
      plugin: "objects",
      db: getDb(),
    }).upsert({
      kind: "object",
      key: "1",
      label: "ENG-1",
      title: "Saved issue",
      objectType: "task",
      status: "Started",
      url: "https://example.com/issues/1",
    });
    const coordinates = {
      channel: "D123",
      message_ts: "1700000000.000002",
      thread_ts: "1700000000.000001",
    };
    const id = JSON.stringify(["objects", "1"]);
    expect(
      await requestDetails(id, "U123", "T123", "annotation", coordinates),
    ).toMatchObject({
      metadata: {
        entity_type: "slack#/entities/task",
        external_ref: { id, type: "annotation" },
        entity_payload: {
          attributes: { title: { text: "Saved issue" } },
          fields: { status: { value: "Started" } },
        },
      },
    });
    await createPluginAnnotations({
      conversationId,
      plugin: "objects",
      db: getDb(),
    }).upsert({
      kind: "object",
      key: "1",
      label: "ENG-1",
      title: "Updated issue",
      objectType: "task",
      status: "Done",
      url: "https://example.com/issues/1",
    });
    expect(
      await requestDetails(id, "U123", "T123", "annotation", coordinates),
    ).toMatchObject({
      metadata: {
        external_ref: { id, type: "annotation" },
        entity_payload: {
          attributes: { title: { text: "Updated issue" } },
          fields: { status: { value: "Done" } },
        },
      },
    });
    await upsertIdentity(getSqlExecutor(), {
      kind: "user",
      provider: "slack",
      providerTenantId: "T123",
      providerSubjectId: "U999",
      email: "other@example.com",
      emailVerified: true,
    });
    const denied = await requestDetails(
      id,
      "U999",
      "T123",
      "annotation",
      coordinates,
    );
    expect(denied).toMatchObject({ error: { status: "not_found" } });
    expect(denied).not.toHaveProperty("metadata");
    expect(
      await requestDetails(id, "U123", "T999", "annotation", coordinates),
    ).toMatchObject({ error: { status: "not_found" } });
    expect(
      await requestDetails(id, "U123", "T123", "annotation"),
    ).toMatchObject({ error: { status: "not_found" } });

    // The same object in a different thread must not borrow private facts.
    const publicConversationId = "slack:C123:annotation";
    await getConversationStore().recordActivity({
      conversationId: publicConversationId,
      actor: { platform: "slack", teamId: "T123", slackUserId: "U123" },
      destination: { platform: "slack", teamId: "T123", channelId: "C123" },
      visibility: "public",
    });
    await getConversationStore().bindProviderConversation({
      conversationId: publicConversationId,
      provider: "slack",
      providerTenantId: "T123",
      providerDestinationId: "C123",
      providerConversationId: coordinates.thread_ts,
    });
    // Bound, top-level notifications have message_ts without thread_ts.
    const publicCoordinates = {
      channel: "C123",
      message_ts: coordinates.thread_ts,
    };
    expect(
      await requestDetails(id, "U123", "T123", "annotation", publicCoordinates),
    ).toMatchObject({ error: { status: "not_found" } });
    await createPluginAnnotations({
      conversationId: publicConversationId,
      plugin: "objects",
      db: getDb(),
    }).upsert({
      kind: "object",
      key: "1",
      label: "ENG-1",
      title: "Public issue facts",
      objectType: "task",
      url: "https://example.com/issues/1",
    });
    expect(
      await requestDetails(id, "U999", "T123", "annotation", publicCoordinates),
    ).toMatchObject({
      metadata: {
        external_ref: { id, type: "annotation" },
        entity_payload: {
          attributes: { title: { text: "Public issue facts" } },
        },
      },
    });
  });

  it("loads a private scheduled Automation for its owner and refreshes its saved facts", async () => {
    const task = await saveReminder();
    expect(await requestDetails(task.id)).toMatchObject({
      trigger_id: `trigger-${task.id}`,
      metadata: {
        external_ref: { id: task.id, type: "automation" },
        entity_type: "slack#/entities/item",
        url: `https://junior.example.com/automations/${task.id}`,
        entity_payload: {
          attributes: {
            title: { text: "Water reminder" },
            display_type: "Scheduled automation",
          },
          custom_fields: [
            { key: "status", value: "active" },
            {
              key: "description",
              label: "Instruction",
              value: task.task.text,
              format: "markdown",
            },
            { key: "trigger", value: "Every day at noon" },
            {
              key: "next_run",
              type: "slack#/types/timestamp",
              value: Math.floor(task.nextRunAtMs! / 1000),
            },
            { key: "outcomes", value: "None (silent)" },
            { key: "destination", value: "Channel D123 · private" },
            { key: "created_by", value: "Reminder owner" },
            {
              key: "date_created",
              type: "slack#/types/timestamp",
              value: Math.floor(task.createdAtMs / 1000),
            },
            { key: "executions", value: "0 total · 0 in the last 30 days" },
            { key: "last_run", value: "Never run" },
          ],
        },
      },
    });
    await saveScheduledAutomation(getDb(), {
      ...task,
      title: "Updated reminder",
      status: "blocked",
      nextRunAtMs: undefined,
      task: { text: "Updated instruction." },
      outcomes: [{ action: "send_message", destination: task.destination }],
    });
    await getConversationStore().recordActivity({
      conversationId: "agent-dispatch:reminder-run",
      actor: { platform: "slack", teamId: "T123", slackUserId: "U123" },
      destination: task.destination,
      visibility: "private",
      title: "Reminder execution",
    });
    const executedAtMs = Date.now();
    await recordAutomationExecution("scheduled", task.id, {
      conversationId: "agent-dispatch:reminder-run",
      executionId: "reminder-run",
      nowMs: executedAtMs,
      status: "completed",
    });
    const refreshed = await requestDetails(task.id);
    expect(refreshed).toMatchObject({
      metadata: {
        entity_payload: {
          attributes: { title: { text: "Updated reminder" } },
          custom_fields: expect.arrayContaining([
            expect.objectContaining({
              key: "status",
              value: "blocked",
            }),
            expect.objectContaining({
              key: "description",
              value: "Updated instruction.",
            }),
            expect.objectContaining({ key: "next_run", value: "None" }),
            expect.objectContaining({ key: "outcomes", value: "1 message" }),
            expect.objectContaining({
              key: "executions",
              value: "1 total · 1 in the last 30 days",
            }),
            expect.objectContaining({
              key: "last_run",
              type: "slack#/types/timestamp",
              value: Math.floor(executedAtMs / 1000),
              link: "https://junior.example.com/conversations/agent-dispatch%3Areminder-run",
            }),
          ]),
        },
      },
    });
  });

  it("loads public event Automations for another user in the same workspace", async () => {
    await saveReminder();
    await getConversationStore().recordActivity({
      conversationId: "slack:C123:public",
      actor: {
        platform: "slack",
        teamId: "T123",
        slackUserId: "U999",
        email: "other@example.com",
      },
      destination: { platform: "slack", teamId: "T123", channelId: "C123" },
      channelName: "project",
      visibility: "public",
      title: "Public automation",
    });
    await createEventAutomation(getDb(), {
      id: "event_public",
      title: "Issue updates",
      createdAtMs: Date.now(),
      createdBy: { slackUserId: "U999" },
      credentialMode: "system",
      destination: { platform: "slack", teamId: "T123", channelId: "C123" },
      destinationVisibility: "public",
      outcomes: [],
      task: { text: "Summarize the closed issue." },
      trigger: {
        namespace: "linear",
        resourceType: "issue",
        identifier: "ACME-42",
        label: "Issue",
        events: ["issue.closed"],
      },
    });
    expect(await requestDetails("event_public")).toMatchObject({
      metadata: {
        external_ref: { id: "event_public", type: "automation" },
        entity_payload: {
          attributes: {
            title: { text: "Issue updates" },
            display_type: "Event automation",
          },
          custom_fields: expect.arrayContaining([
            expect.objectContaining({
              key: "status",
              value: "unavailable",
            }),
            expect.objectContaining({
              key: "description",
              value: "Summarize the closed issue.",
            }),
            expect.objectContaining({ key: "source", value: "linear" }),
            expect.objectContaining({
              key: "resource",
              value: "Issue · ACME-42",
            }),
            expect.objectContaining({ key: "events", value: "issue.closed" }),
            expect.objectContaining({
              key: "destination",
              value: "#project · public",
            }),
            expect.objectContaining({
              key: "warning",
              value:
                "Trigger unavailable. This automation cannot receive events.",
            }),
          ]),
        },
      },
    });
    expect(await requestDetails("event_public", "U123", "T_OTHER")).toEqual({
      trigger_id: "trigger-event_public",
      error: { status: "not_found" },
    });
  });

  it("returns no object facts for private, deleted, or missing Automations", async () => {
    const task = await saveReminder();
    await upsertIdentity(getSqlExecutor(), {
      kind: "user",
      provider: "slack",
      providerTenantId: "T123",
      providerSubjectId: "U999",
      email: "other@example.com",
      emailVerified: true,
    });
    expect(await requestDetails(task.id, "U999")).toEqual({
      trigger_id: `trigger-${task.id}`,
      error: { status: "not_found" },
    });
    await saveScheduledAutomation(getDb(), { ...task, status: "deleted" });
    for (const id of [task.id, "sched_missing"]) {
      expect(await requestDetails(id)).toEqual({
        trigger_id: `trigger-${id}`,
        error: { status: "not_found" },
      });
    }
  });
});
