import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import { mswServer } from "../../msw/server";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import { loadEventPromptRegistry } from "@/chat/events/registry";
import {
  getDispatchRecord,
  listIncompleteDispatchIds,
} from "@/chat/agent-dispatch/store";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import type { WaitUntilFn } from "@/handlers/types";
import { handlePlatformWebhook } from "@/handlers/webhooks";

const SIGNING_SECRET = "test-signing-secret";
const { ORIGINAL_ENV } = vi.hoisted(() => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  process.env.JUNIOR_BASE_URL = "https://example.test";
  process.env.JUNIOR_SECRET = "test-dispatch-secret";
  return { ORIGINAL_ENV };
});

function signSlackBody(body: string, timestamp: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(base).digest("hex")}`;
}

function createSlackRequest(body: string): Request {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://example.test/api/webhooks/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signSlackBody(body, timestamp),
    },
    body,
  });
}

function collectWaitUntil(tasks: Array<Promise<unknown>>): WaitUntilFn {
  return (task) => {
    tasks.push(typeof task === "function" ? task() : task);
  };
}

async function flushWaitUntil(tasks: Array<Promise<unknown>>): Promise<void> {
  for (let index = 0; index < tasks.length; index += 1) {
    await tasks[index];
  }
}

async function writeEventBinding(root: string): Promise<void> {
  const eventsDir = path.join(root, "app", "events", "slack");
  await fs.mkdir(eventsDir, { recursive: true });
  await fs.writeFile(
    path.join(eventsDir, "root-channel.md"),
    [
      "---",
      "id: slack-root-channel",
      "event: slack.channel.message.created",
      "scope:",
      "  channelId: CEVNT",
      "context:",
      "  include:",
      "    - source_message",
      "---",
      "",
      "Review this root channel message.",
      "",
    ].join("\n"),
  );
}

describe("Slack event prompts: root channel messages", () => {
  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_BASE_URL: "https://example.test",
      JUNIOR_SECRET: "test-dispatch-secret",
      JUNIOR_STATE_ADAPTER: "memory",
    };
    resetSlackApiMockState();
    await disconnectStateAdapter();
    mswServer.use(
      http.post("https://example.test/api/internal/agent-dispatch", () =>
        HttpResponse.json({ ok: true }),
      ),
    );
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    const emptyRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-events-empty-"),
    );
    await loadEventPromptRegistry(emptyRoot);
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("dispatches root channel messages and ignores thread replies", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "junior-events-"));
    await writeEventBinding(root);
    await loadEventPromptRegistry(root);
    const bot = new JuniorChat({
      userName: "junior",
      adapters: {
        slack: createJuniorSlackAdapter({
          botToken: "xoxb-test",
          signingSecret: SIGNING_SECRET,
        }),
      },
      state: createMemoryState(),
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];

    const rootBody = JSON.stringify({
      ...slackEventsApiEnvelope({
        eventType: "message",
        channel: "CEVNT",
        text: "the build failed",
        ts: "1700000000.000001",
        user: "U123",
      }),
      team_id: "T123",
      event_id: "Ev123",
    });
    const rootResponse = await handlePlatformWebhook(
      createSlackRequest(rootBody),
      "slack",
      collectWaitUntil(waitUntilTasks),
      bot,
    );
    await flushWaitUntil(waitUntilTasks);

    expect(rootResponse.status).toBe(200);
    expect(getCapturedSlackApiCalls("auth.test")).toHaveLength(1);
    const idsAfterRoot = await listIncompleteDispatchIds();
    expect(idsAfterRoot).toHaveLength(1);
    await expect(
      getDispatchRecord(idsAfterRoot[0] ?? ""),
    ).resolves.toMatchObject({
      plugin: "event-prompts",
      idempotencyKey: "event:slack-root-channel:Ev123",
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "CEVNT",
      },
      metadata: {
        bindingId: "slack-root-channel",
        eventId: "slack.channel.message.created",
        sourceEventId: "Ev123",
      },
    });

    waitUntilTasks.length = 0;
    const replyBody = JSON.stringify({
      ...slackEventsApiEnvelope({
        eventType: "message",
        channel: "CEVNT",
        text: "thread follow-up",
        ts: "1700000000.000002",
        threadTs: "1700000000.000001",
        user: "U123",
      }),
      team_id: "T123",
      event_id: "Ev124",
    });
    const replyResponse = await handlePlatformWebhook(
      createSlackRequest(replyBody),
      "slack",
      collectWaitUntil(waitUntilTasks),
      bot,
    );
    await flushWaitUntil(waitUntilTasks);

    expect(replyResponse.status).toBe(200);
    await expect(listIncompleteDispatchIds()).resolves.toEqual(idsAfterRoot);

    waitUntilTasks.length = 0;
    const mentionBody = JSON.stringify({
      ...slackEventsApiEnvelope({
        eventType: "message",
        channel: "CEVNT",
        text: "<@U_BOT> can you look at this?",
        ts: "1700000000.000003",
        user: "U123",
      }),
      team_id: "T123",
      event_id: "Ev125",
    });
    const mentionResponse = await handlePlatformWebhook(
      createSlackRequest(mentionBody),
      "slack",
      collectWaitUntil(waitUntilTasks),
      bot,
    );
    await flushWaitUntil(waitUntilTasks);

    expect(mentionResponse.status).toBe(200);
    await expect(listIncompleteDispatchIds()).resolves.toEqual(idsAfterRoot);
  });

  it("dispatches multi-workspace events inside the installed Slack bot context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "junior-events-"));
    await writeEventBinding(root);
    await loadEventPromptRegistry(root);
    const bot = new JuniorChat({
      userName: "junior",
      adapters: {
        slack: createJuniorSlackAdapter({
          clientId: "client-id",
          clientSecret: "client-secret",
          signingSecret: SIGNING_SECRET,
        }),
      },
      state: createMemoryState(),
    });
    await bot.initialize();
    const slackAdapter = bot.getAdapter("slack") as unknown as {
      setInstallation(
        teamId: string,
        installation: {
          botToken: string;
          botUserId: string;
          teamName: string;
        },
      ): Promise<void>;
    };
    await slackAdapter.setInstallation("T123", {
      botToken: "xoxb-installed",
      botUserId: "U_BOT",
      teamName: "Installed Workspace",
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];

    const rootBody = JSON.stringify({
      ...slackEventsApiEnvelope({
        eventType: "message",
        channel: "CEVNT",
        text: "the build failed again",
        ts: "1700000000.000010",
        user: "U123",
      }),
      team_id: "T123",
      event_id: "EvMulti123",
    });
    const response = await handlePlatformWebhook(
      createSlackRequest(rootBody),
      "slack",
      collectWaitUntil(waitUntilTasks),
      bot,
    );
    await flushWaitUntil(waitUntilTasks);

    expect(response.status).toBe(200);
    const ids = await listIncompleteDispatchIds();
    expect(ids).toHaveLength(1);
    await expect(getDispatchRecord(ids[0] ?? "")).resolves.toMatchObject({
      plugin: "event-prompts",
      idempotencyKey: "event:slack-root-channel:EvMulti123",
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "CEVNT",
      },
    });
  });

  it("dispatches org-wide Enterprise Grid events from the enterprise installation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "junior-events-"));
    await writeEventBinding(root);
    await loadEventPromptRegistry(root);
    const bot = new JuniorChat({
      userName: "junior",
      adapters: {
        slack: createJuniorSlackAdapter({
          clientId: "client-id",
          clientSecret: "client-secret",
          signingSecret: SIGNING_SECRET,
        }),
      },
      state: createMemoryState(),
    });
    await bot.initialize();
    const slackAdapter = bot.getAdapter("slack") as unknown as {
      setInstallation(
        teamId: string,
        installation: {
          botToken: string;
          botUserId: string;
          teamName: string;
        },
      ): Promise<void>;
    };
    await slackAdapter.setInstallation("E123", {
      botToken: "xoxb-enterprise-installed",
      botUserId: "U_BOT",
      teamName: "Enterprise Install",
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];

    const rootBody = JSON.stringify({
      ...slackEventsApiEnvelope({
        eventType: "message",
        channel: "CEVNT",
        text: "enterprise build failed",
        ts: "1700000000.000020",
        user: "U123",
      }),
      team_id: "T123",
      enterprise_id: "E123",
      is_enterprise_install: true,
      event_id: "EvEnterprise123",
    });
    const response = await handlePlatformWebhook(
      createSlackRequest(rootBody),
      "slack",
      collectWaitUntil(waitUntilTasks),
      bot,
    );
    await flushWaitUntil(waitUntilTasks);

    expect(response.status).toBe(200);
    const ids = await listIncompleteDispatchIds();
    expect(ids).toHaveLength(1);
    await expect(getDispatchRecord(ids[0] ?? "")).resolves.toMatchObject({
      plugin: "event-prompts",
      idempotencyKey: "event:slack-root-channel:EvEnterprise123",
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "CEVNT",
      },
    });
  });
});
