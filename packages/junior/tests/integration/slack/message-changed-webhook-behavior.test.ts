import { createHmac } from "node:crypto";
import type { SlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { afterEach, describe, expect, it } from "vitest";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import { createJuniorSlackAdapter } from "@/chat/ingress/slack-webhook";
import {
  slackEventsApiEnvelope,
  slackMessageChangedEnvelope,
} from "../../fixtures/slack/factories/events";

const SIGNING_SECRET = "test-signing-secret";

function signSlackRequest(
  body: string,
  signingSecret = SIGNING_SECRET,
): Request {
  const timestamp = `${Math.floor(Date.now() / 1000)}`;
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;

  return new Request("https://junior.example.com/api/webhooks/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

async function flushTasks(tasks: Promise<unknown>[]): Promise<void> {
  await Promise.allSettled(tasks);
}

async function sendWebhook(
  adapter: SlackAdapter,
  payload: unknown,
  signingSecret = SIGNING_SECRET,
): Promise<Response> {
  const tasks: Promise<unknown>[] = [];
  const response = await adapter.handleWebhook(
    signSlackRequest(JSON.stringify(payload), signingSecret),
    {
      waitUntil(task) {
        tasks.push(task);
      },
    },
  );
  await flushTasks(tasks);
  return response;
}

interface RecordedMessage {
  attachmentNames: string[];
  id: string;
  isMention: boolean | undefined;
  linkUrls: string[];
  rawTs: string | undefined;
  text: string;
  threadId: string;
}

function recordMessage(
  threadId: string,
  message: {
    attachments: Array<{ name?: string }>;
    id: string;
    isMention?: boolean;
    links?: Array<{ url: string }>;
    raw: unknown;
    text: string;
  },
): RecordedMessage {
  const rawTs =
    message.raw &&
    typeof message.raw === "object" &&
    typeof (message.raw as { ts?: unknown }).ts === "string"
      ? ((message.raw as { ts: string }).ts ?? undefined)
      : undefined;

  return {
    threadId,
    id: message.id,
    text: message.text,
    isMention: message.isMention,
    rawTs,
    attachmentNames: message.attachments.map(
      (attachment) => attachment.name ?? "",
    ),
    linkUrls: (message.links ?? []).map((link) => link.url),
  };
}

async function createBot(args: {
  clientId?: string;
  clientSecret?: string;
  botToken?: string;
  botUserId?: string;
  subscribeMentions?: boolean;
}) {
  const adapter = createJuniorSlackAdapter({
    signingSecret: SIGNING_SECRET,
    ...(args.botToken ? { botToken: args.botToken } : {}),
    ...(args.botUserId ? { botUserId: args.botUserId } : {}),
    ...(args.clientId ? { clientId: args.clientId } : {}),
    ...(args.clientSecret ? { clientSecret: args.clientSecret } : {}),
  });
  const state = createMemoryState();
  const bot = new JuniorChat<{ slack: SlackAdapter }>({
    userName: "junior",
    adapters: { slack: adapter },
    state,
  });

  const deliveries: string[] = [];
  const mentions: RecordedMessage[] = [];
  const subscribed: RecordedMessage[] = [];
  bot.onNewMention(async (thread, message) => {
    if (args.subscribeMentions) {
      await thread.subscribe();
    }
    deliveries.push(`mention:${message.text}`);
    mentions.push(recordMessage(thread.id, message));
  });
  bot.onSubscribedMessage(async (thread, message) => {
    deliveries.push(`subscribed:${message.text}`);
    subscribed.push(recordMessage(thread.id, message));
  });

  await bot.initialize();
  return { adapter, bot, deliveries, mentions, subscribed };
}

describe("Slack webhook behavior: edited messages", () => {
  const bots: Array<JuniorChat<{ slack: SlackAdapter }>> = [];

  afterEach(async () => {
    while (bots.length > 0) {
      await bots.pop()?.shutdown();
    }
  });

  it("dispatches a verified message_changed edit that newly adds a mention", async () => {
    const { adapter, bot, mentions } = await createBot({
      botToken: "xoxb-test-token",
      botUserId: "U_BOT",
    });
    bots.push(bot);

    const response = await sendWebhook(
      adapter,
      slackMessageChangedEnvelope({
        newText: "<@U_BOT> can you take a look?",
        previousText: "can you take a look?",
      }),
    );

    expect(response.status).toBe(200);
    expect(mentions).toEqual([
      expect.objectContaining({
        threadId: "slack:C_TEST:1700000000.000",
        text: "@U_BOT can you take a look?",
        isMention: true,
      }),
    ]);
  });

  it("rejects invalid signatures before dispatching edited mentions", async () => {
    const { adapter, bot, mentions } = await createBot({
      botToken: "xoxb-test-token",
      botUserId: "U_BOT",
    });
    bots.push(bot);

    const response = await sendWebhook(
      adapter,
      slackMessageChangedEnvelope(),
      "wrong-secret",
    );

    expect(response.status).toBe(401);
    expect(mentions).toHaveLength(0);
  });

  it("uses the installed workspace bot user id in multi-workspace mode", async () => {
    const { adapter, bot, mentions } = await createBot({
      clientId: "client-id",
      clientSecret: "client-secret",
    });
    bots.push(bot);

    await adapter.setInstallation("T_TEST", {
      botToken: "xoxb-installed-token",
      botUserId: "U_INSTALL_BOT",
      teamName: "Test Workspace",
    });

    const response = await sendWebhook(
      adapter,
      slackMessageChangedEnvelope({
        newText: "<@U_INSTALL_BOT> can you take a look?",
        previousText: "can you take a look?",
      }),
    );

    expect(response.status).toBe(200);
    expect(mentions).toEqual([
      expect.objectContaining({
        threadId: "slack:C_TEST:1700000000.000",
        text: "@U_INSTALL_BOT can you take a look?",
        isMention: true,
      }),
    ]);
  });

  it("replays an edited mention after the original subscribed-thread message was already processed", async () => {
    const { adapter, bot, deliveries, subscribed } = await createBot({
      botToken: "xoxb-test-token",
      botUserId: "U_BOT",
      subscribeMentions: true,
    });
    bots.push(bot);

    await sendWebhook(
      adapter,
      slackEventsApiEnvelope({
        eventType: "app_mention",
        text: "<@U_BOT> keep watching this thread",
        ts: "1700000000.000",
      }),
    );
    await sendWebhook(
      adapter,
      slackEventsApiEnvelope({
        eventType: "message",
        text: "can you take a look?",
        threadTs: "1700000000.000",
        ts: "1700000000.100",
      }),
    );
    await sendWebhook(
      adapter,
      slackMessageChangedEnvelope({
        editedTs: "1700000000.200",
        messageTs: "1700000000.100",
        newText: "<@U_BOT> can you take a look?",
        previousText: "can you take a look?",
        threadTs: "1700000000.000",
      }),
    );

    expect(deliveries).toEqual([
      "mention:@U_BOT keep watching this thread",
      "subscribed:can you take a look?",
      "subscribed:@U_BOT can you take a look?",
    ]);
    expect(subscribed[1]).toEqual(
      expect.objectContaining({
        isMention: true,
        rawTs: "1700000000.100",
        text: "@U_BOT can you take a look?",
      }),
    );
    expect(subscribed[1]?.id).not.toBe("1700000000.100");
  });

  it("preserves files and rich-text links when an edit adds a mention", async () => {
    const { adapter, bot, mentions } = await createBot({
      botToken: "xoxb-test-token",
      botUserId: "U_BOT",
    });
    bots.push(bot);

    const response = await sendWebhook(
      adapter,
      slackMessageChangedEnvelope({
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "link",
                    url: "https://example.com/deploys/123",
                    text: "deploy",
                  },
                ],
              },
            ],
          },
        ],
        editedTs: "1700000000.200",
        files: [
          {
            id: "F_TEST",
            mimetype: "image/png",
            name: "deploy.png",
            original_h: 480,
            original_w: 640,
            size: 1234,
            url_private:
              "https://files.slack.com/files-pri/T_TEST-F_TEST/deploy.png",
          },
        ],
        newText: "<@U_BOT> check the deploy screenshot",
        previousText: "check the deploy screenshot",
      }),
    );

    expect(response.status).toBe(200);
    expect(mentions).toEqual([
      expect.objectContaining({
        attachmentNames: ["deploy.png"],
        linkUrls: ["https://example.com/deploys/123"],
        text: "@U_BOT check the deploy screenshot",
      }),
    ]);
  });
});
