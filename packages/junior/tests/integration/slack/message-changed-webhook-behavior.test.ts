import { createHmac } from "node:crypto";
import type { SlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { afterEach, describe, expect, it } from "vitest";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import { createJuniorSlackAdapter } from "@/chat/ingress/slack-webhook";
import { slackMessageChangedEnvelope } from "../../fixtures/slack/factories/events";

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

async function createBot(args: {
  clientId?: string;
  clientSecret?: string;
  botToken?: string;
  botUserId?: string;
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

  const mentions: Array<{
    isMention: boolean | undefined;
    text: string;
    threadId: string;
  }> = [];
  bot.onNewMention(async (thread, message) => {
    mentions.push({
      threadId: thread.id,
      text: message.text,
      isMention: message.isMention,
    });
  });

  await bot.initialize();
  return { adapter, bot, mentions };
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

    const tasks: Promise<unknown>[] = [];
    const request = signSlackRequest(
      JSON.stringify(
        slackMessageChangedEnvelope({
          newText: "<@U_BOT> can you take a look?",
          previousText: "can you take a look?",
        }),
      ),
    );

    const response = await adapter.handleWebhook(request, {
      waitUntil(task) {
        tasks.push(task);
      },
    });
    await flushTasks(tasks);

    expect(response.status).toBe(200);
    expect(mentions).toEqual([
      {
        threadId: "slack:C_TEST:1700000000.000",
        text: "@U_BOT can you take a look?",
        isMention: true,
      },
    ]);
  });

  it("rejects invalid signatures before dispatching edited mentions", async () => {
    const { adapter, bot, mentions } = await createBot({
      botToken: "xoxb-test-token",
      botUserId: "U_BOT",
    });
    bots.push(bot);

    const tasks: Promise<unknown>[] = [];
    const request = signSlackRequest(
      JSON.stringify(slackMessageChangedEnvelope()),
      "wrong-secret",
    );

    const response = await adapter.handleWebhook(request, {
      waitUntil(task) {
        tasks.push(task);
      },
    });
    await flushTasks(tasks);

    expect(response.status).toBe(401);
    expect(mentions).toHaveLength(0);
    expect(tasks).toHaveLength(0);
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

    const tasks: Promise<unknown>[] = [];
    const request = signSlackRequest(
      JSON.stringify(
        slackMessageChangedEnvelope({
          newText: "<@U_INSTALL_BOT> can you take a look?",
          previousText: "can you take a look?",
        }),
      ),
    );

    const response = await adapter.handleWebhook(request, {
      waitUntil(task) {
        tasks.push(task);
      },
    });
    await flushTasks(tasks);

    expect(response.status).toBe(200);
    expect(mentions).toEqual([
      {
        threadId: "slack:C_TEST:1700000000.000",
        text: "@U_INSTALL_BOT can you take a look?",
        isMention: true,
      },
    ]);
  });
});
