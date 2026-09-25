import { createMemoryState } from "@chat-adapter/state-memory";
import { afterEach, describe, expect, it } from "vitest";
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

const SIGNING_SECRET = "test-signing-secret";

describe("Slack webhook auth boundary", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("drops unknown authors before replies or stored input", async () => {
    const channel = "C123";
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
    });
    const services = {
      getSlackAdapter: () => adapter,
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      state,
    };

    for (const userTeam of [undefined, 123]) {
      const rejected = await handleSlackWebhookAndFlush({
        request: slackWebhookRequest({
          ...envelope,
          event: { ...envelope.event, user_team: userTeam },
        }),
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

    const accepted = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(envelope),
      services,
    });
    expect(accepted.status).toBe(200);
    expect(queue.queuedMessages()).toHaveLength(1);
    await state.disconnect();
  });

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

      for (const [index, userTeam] of [undefined, "T123"].entries()) {
        const message = createTestMessage({
          id: `1712345.000${index + 1}`,
          threadId,
          text: userTeam ?? "unknown",
          author: { userId: "U123" },
          raw: { user_team: userTeam },
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

      expect(handled).toEqual(["T123"]);
      await bot.shutdown();
    },
  );

  it.each([
    { channel: 123 },
    { files: {} },
    { files: [{ mimetype: 123 }] },
    { blocks: [{ type: "rich_text", elements: {} }] },
    {
      blocks: [
        {
          type: "rich_text",
          elements: [{ type: "rich_text_section", elements: [null] }],
        },
      ],
    },
    { attachments: [{ from_url: 123, title: "preview" }] },
    { ts: "not-a-timestamp" },
    { thread_ts: "99999999999999999" },
    { edited: { ts: "not-a-timestamp" } },
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
      edited: { ts: "1712345.0002" },
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "See ", style: { bold: true } },
                { type: "link", url: "https://example.com/task", text: "task" },
              ],
            },
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
          url_private_download: "https://files.slack.com/download/note.txt",
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
      future_field: { retained: true },
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

  it("requires slash command identity and destination before accepting work", async () => {
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
    for (const field of ["team_id", "channel_id", "user_id"]) {
      const response = await handleSlackWebhook({
        request: client.form(new URLSearchParams({ ...form, [field]: "" })),
        services,
        waitUntil: waitUntil.fn,
      });
      expect(response.status).toBe(400);
    }
    expect(waitUntil.pendingCount()).toBe(0);
    expect(slackApiOutbox.messages()).toEqual([]);

    const accepted = await handleSlackWebhook({
      request: client.form(new URLSearchParams(form)),
      services,
      waitUntil: waitUntil.fn,
    });
    expect(accepted.status).toBe(200);
    await waitUntil.flush();
    expect(slackApiOutbox.calls("chat.postEphemeral")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          user: "U123",
          text: expect.stringContaining("link <provider>"),
        }),
      }),
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
