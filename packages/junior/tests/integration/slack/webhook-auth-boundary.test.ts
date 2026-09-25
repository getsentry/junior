import { createMemoryState } from "@chat-adapter/state-memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDb, getConversationEventStore } from "@/chat/db";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import { runWithWorkspaceTeamId } from "@/chat/ingress/workspace-membership";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import {
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";
import { createTestMessage } from "../../fixtures/slack-harness";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { usersInfoOk } from "../../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiResponse,
  queueSlackApiError,
} from "../../msw/handlers/slack-api";

const SIGNING_SECRET = "test-signing-secret";

describe("Slack webhook auth boundary", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeDb();
  });

  it.each([
    { channel: "C123", eventType: "app_mention" as const },
    { channel: "D123", eventType: "message" as const },
    { channel: "C123", eventType: "message" as const },
  ])(
    "verifies authors without team fields before accepting $eventType in $channel",
    async ({ channel, eventType }) => {
      const state = createMemoryState();
      await state.connect();
      const threadTs = "1712345.0001";
      const threadId = `slack:${channel}:${threadTs}`;
      await state.subscribe(threadId);
      const queue = createConversationWorkQueueTestAdapter();
      const adapter = createSlackAdapterFixture();
      const envelope = slackEnvelope({
        channel,
        threadTs,
        eventType,
        text: "hello",
      });
      if (eventType === "app_mention") {
        envelope.event.text = `<@${adapter.botUserId}> hello`;
      }
      const event = { ...envelope.event, user_team: undefined };
      const services = {
        getSlackAdapter: () => adapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      };

      const profile = usersInfoOk({ userId: "U123" });
      for (const teamId of [undefined, "TEXTERNAL"]) {
        queueSlackApiResponse("users.info", {
          body: { ...profile, user: { ...profile.user, team_id: teamId } },
        });
        const rejected = await handleSlackWebhookAndFlush({
          request: slackWebhookRequest({ ...envelope, event }),
          services,
        });
        expect(rejected.status).toBe(200);
      }
      expect(queue.queuedMessages()).toEqual([]);
      expect(
        await getConversationWorkState({ conversationId: threadId, state }),
      ).toBeUndefined();
      expect(
        (await getConversationEventStore().loadMessageHistory(threadId)).events,
      ).toEqual([]);
      expect(slackApiOutbox.messages()).toEqual([]);
      expect(slackApiOutbox.reactions()).toEqual([]);

      queueSlackApiError("users.info", { error: "missing_scope" });
      const failed = await handleSlackWebhookAndFlush({
        request: slackWebhookRequest({ ...envelope, event }),
        services,
      });
      expect(failed.status).toBe(503);
      expect(queue.queuedMessages()).toEqual([]);
      expect(slackApiOutbox.reactions()).toEqual([]);

      queueSlackApiResponse("users.info", {
        body: { ...profile, user: { ...profile.user, team_id: "T123" } },
      });
      const accepted = await handleSlackWebhookAndFlush({
        request: slackWebhookRequest({ ...envelope, event }),
        services,
      });
      expect(accepted.status).toBe(200);
      expect(queue.queuedMessages()).toHaveLength(1);
      expect(
        getCapturedSlackApiCalls("users.info").at(-1)?.params,
      ).toMatchObject({ user: "U123" });
      await state.disconnect();
    },
  );

  it.each(["message", "factory"] as const)(
    "checks membership before SDK routing for a %s",
    async (mode) => {
      const state = createMemoryState();
      const adapter = createSlackAdapterFixture();
      const bot = new JuniorChat({
        userName: "junior",
        adapters: { slack: adapter },
        state,
      });
      const handled: string[] = [];
      bot.onDirectMessage(async (_thread, message) => {
        handled.push(message.text);
      });
      await bot.initialize();
      const client = createSlackWebhookTestClient({
        signingSecret: SIGNING_SECRET,
      });
      const waitUntil = client.waitUntil();
      const threadId = "slack:D123:1712345.0001";

      const profile = usersInfoOk({ userId: "U123" });
      queueSlackApiResponse("users.info", {
        body: { ...profile, user: { ...profile.user, team_id: "T123" } },
      });
      for (const [index, userTeam] of ["TEXTERNAL", undefined].entries()) {
        const message = createTestMessage({
          id: `1712345.000${index + 1}`,
          threadId,
          text: userTeam ?? "verified",
          author: { userId: "U123" },
          raw: { user: "U123", user_team: userTeam },
        });
        await runWithWorkspaceTeamId("T123", () =>
          bot.processMessage(
            adapter,
            threadId,
            mode === "factory" ? async () => message : message,
            { waitUntil: waitUntil.fn },
          ),
        );
        await waitUntil.flush();
      }

      expect(handled).toEqual(["verified"]);
      await bot.shutdown();
    },
  );

  it.each([
    { channel: 123 },
    { files: {} },
    { blocks: [{ type: "rich_text", elements: {} }] },
    { attachments: [{ from_url: 123, title: "preview" }] },
    { ts: "not-a-timestamp" },
    { thread_ts: "99999999999999999" },
  ])("rejects malformed signed payloads: %j", async (invalidFields) => {
    const client = createSlackWebhookTestClient({
      signingSecret: SIGNING_SECRET,
    });
    const waitUntil = client.waitUntil();
    const queue = createConversationWorkQueueTestAdapter();
    const adapter = createSlackAdapterFixture();
    const envelope = slackEnvelope({});
    const response = await handleSlackWebhook({
      request: slackWebhookRequest({
        ...envelope,
        event: { ...envelope.event, ...invalidFields },
      }),
      waitUntil: waitUntil.fn,
      services: {
        getSlackAdapter: () => adapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
      },
    });
    expect(response.status).toBe(400);
    expect(queue.sentRecords()).toEqual([]);
    expect(waitUntil.pendingCount()).toBe(0);
    expect(slackApiOutbox.messages()).toEqual([]);
    expect(slackApiOutbox.reactions()).toEqual([]);
  });

  it("preserves rich message fields through validation and durable handoff", async () => {
    const state = createMemoryState();
    const adapter = createSlackAdapterFixture();
    const queue = createConversationWorkQueueTestAdapter();
    const envelope = slackEnvelope({
      channel: "D123",
      threadTs: "1712345.0001",
    });
    const event = {
      ...envelope.event,
      subtype: "file_share",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_list",
              style: "bullet",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "nested" }],
                },
              ],
            },
          ],
        },
      ],
      files: [
        {
          id: "F123",
          name: "note.txt",
          mimetype: "text/plain",
          url_private: "https://files.slack.com/note.txt",
        },
      ],
      attachments: [
        {
          from_url: "https://example.com/task",
          title: "Task",
          text: "Details",
          fields: [{ title: "Status", value: "open" }],
        },
      ],
    };
    const response = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest({ ...envelope, event }),
      services: {
        getSlackAdapter: () => adapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });
    expect(response.status).toBe(200);
    expect(queue.queuedMessages()).toHaveLength(1);
    const work = await getConversationWorkState({
      conversationId: "slack:D123:1712345.0001",
      state,
    });
    expect(work?.messages[0]?.input.metadata?.message).toMatchObject({
      raw: event,
      attachments: [{ type: "file", name: "note.txt", mimeType: "text/plain" }],
      links: [
        {
          url: "https://example.com/task",
          title: "Task",
          description: "Details",
        },
      ],
    });
    await state.disconnect();
  });

  it("validates slash commands before replying with configured usage", async () => {
    vi.stubEnv("JUNIOR_SLASH_COMMAND", "/team");
    vi.resetModules();
    const { handleSlackWebhook } = await import("@/chat/ingress/slack-webhook");
    const client = createSlackWebhookTestClient({
      signingSecret: SIGNING_SECRET,
    });
    const state = createMemoryState();
    const adapter = createJuniorSlackAdapter({
      signingSecret: SIGNING_SECRET,
      botToken: "xoxb-test-token",
      botUserId: "U0BOT",
    });
    const queue = createConversationWorkQueueTestAdapter();
    const waitUntil = client.waitUntil();
    const form = {
      command: "/junior",
      text: "help",
      user_id: "U123",
      team_id: "T123",
      channel_id: "C123",
    };
    const services = {
      getSlackAdapter: () => adapter,
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      state,
    };
    for (const invalid of [
      { team_id: "" },
      { channel_id: "" },
      { user_id: "" },
      { user_id: "unknown" },
    ]) {
      const response = await handleSlackWebhook({
        request: client.form(new URLSearchParams({ ...form, ...invalid })),
        services,
        waitUntil: waitUntil.fn,
      });
      expect(response.status).toBe(400);
    }
    expect(waitUntil.pendingCount()).toBe(0);
    expect(slackApiOutbox.messages()).toEqual([]);

    for (const text of ["help", "link"]) {
      const accepted = await handleSlackWebhook({
        request: client.form(new URLSearchParams({ ...form, text })),
        services,
        waitUntil: waitUntil.fn,
      });
      expect(accepted.status).toBe(200);
      await waitUntil.flush();
    }
    expect(
      slackApiOutbox.calls("chat.postEphemeral").map((call) => call.params),
    ).toMatchObject([
      {
        channel: "C123",
        user: "U123",
        text: "Usage: `/team link <provider>` or `/team unlink <provider>`",
      },
      { channel: "C123", user: "U123", text: "Usage: `/team link <provider>`" },
    ]);
    expect(queue.sentRecords()).toEqual([]);
    await state.disconnect();
  });

  it("rejects invalid Slack signatures before durable state is required", async () => {
    const client = createSlackWebhookTestClient({
      signingSecret: SIGNING_SECRET,
    });
    const queue = createConversationWorkQueueTestAdapter();
    const waitUntil = client.waitUntil();
    const adapter = createJuniorSlackAdapter({
      botToken: "xoxb-test-token",
      botUserId: "U0BOT",
      signingSecret: SIGNING_SECRET,
    });

    const response = await handleSlackWebhook({
      request: client.invalidSignature({ type: "event_callback" }),
      waitUntil: waitUntil.fn,
      services: {
        getSlackAdapter: () => adapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
      },
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Invalid signature");
    expect(queue.sentRecords()).toEqual([]);
    expect(waitUntil.pendingCount()).toBe(0);
  });
});
