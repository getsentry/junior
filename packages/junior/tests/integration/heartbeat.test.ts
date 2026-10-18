import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineJuniorPlugin,
  type Destination,
} from "@sentry/junior-plugin-api";
import { createHeartbeatContext } from "@/chat/agent-dispatch/context";
import { getDispatchRecord } from "@/chat/agent-dispatch/store";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { upsertTurnRecord } from "@/chat/task-execution/turn-cursor";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { wakePausedTurn } from "@/chat/task-execution/turn-wake";
import type { PiMessage } from "@/chat/pi/messages";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { GET as heartbeat } from "@/handlers/heartbeat";
import { createSlackDirectCredentialSubject } from "@/chat/credentials/subject";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { createWaitUntilCollector } from "../fixtures/wait-until";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

const TEST_NOW_MS = Date.parse("2026-05-26T12:05:00.000Z");
const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} satisfies Destination;
let conversationWorkQueue = createConversationWorkQueueTestAdapter();

function createTestHeartbeatContext(
  args: Omit<
    Parameters<typeof createHeartbeatContext>[0],
    "conversationWorkQueue"
  >,
) {
  return createHeartbeatContext({
    ...args,
    conversationWorkQueue,
  });
}

function testHeartbeat(
  request: Parameters<typeof heartbeat>[0],
  waitUntil: Parameters<typeof heartbeat>[1],
  options: Parameters<typeof heartbeat>[2] = {},
) {
  return heartbeat(request, waitUntil, {
    ...options,
    conversationWorkQueue:
      options.conversationWorkQueue ?? conversationWorkQueue,
  });
}

function createCredentialSubject(
  input: {
    channelId?: string;
    teamId?: string;
    userId?: string;
  } = {},
) {
  const subject = createSlackDirectCredentialSubject({
    channelId: input.channelId ?? "D123",
    teamId: input.teamId ?? "T123",
    userId: input.userId ?? "U123",
  });
  if (!subject) {
    throw new Error("Expected test credential subject to be created");
  }
  return subject;
}

async function persistActiveTurn(
  conversationId: string,
  activeTurnId?: string,
): Promise<void> {
  await persistThreadStateById(conversationId, {
    conversation: {
      schemaVersion: 1,
      compactions: [],
      messages: [],
      processing: {
        activeTurnId,
      },
      vision: {
        byFileId: {},
      },
    },
  });
}

describe("plugin heartbeat", () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    conversationWorkQueue = createConversationWorkQueueTestAdapter();
    vi.useFakeTimers({ now: TEST_NOW_MS });
    process.env.JUNIOR_SCHEDULER_SECRET = "heartbeat-secret";
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";
    process.env.JUNIOR_SECRET = "dispatch-secret";
    setPlugins([]);
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    setPlugins([]);
    await disconnectStateAdapter();
    delete process.env.JUNIOR_SCHEDULER_SECRET;
    delete process.env.CRON_SECRET;
    delete process.env.JUNIOR_BASE_URL;
    delete process.env.JUNIOR_SECRET;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("rejects unauthenticated heartbeat requests", async () => {
    const waitUntil = createWaitUntilCollector();
    const response = await testHeartbeat(
      new Request("https://example.invalid/api/internal/heartbeat"),
      waitUntil.fn,
    );

    expect(response.status).toBe(401);
    expect(waitUntil.pendingCount()).toBe(0);
  });

  it("runs plugin heartbeat hooks", async () => {
    const seen: number[] = [];
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "scheduler",
          displayName: "Scheduler",
          description: "Scheduler test plugin",
        },
        hooks: {
          heartbeat(ctx) {
            seen.push(ctx.nowMs);
          },
        },
      }),
    ]);
    const waitUntil = createWaitUntilCollector();
    const response = await testHeartbeat(
      new Request("https://example.invalid/api/internal/heartbeat", {
        headers: { authorization: "Bearer heartbeat-secret" },
      }),
      waitUntil.fn,
    );

    expect(response.status).toBe(202);
    await waitUntil.flush();
    expect(seen).toHaveLength(1);
  });

  it("reschedules stale paused turn records", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const conversationId = "slack:C123:1712345.0001";
    const sessionId = "turn-timeout";
    const staleNowMs = TEST_NOW_MS - 3 * 60 * 1000;
    vi.setSystemTime(staleNowMs);
    await upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      destination: SLACK_DESTINATION,
      state: "paused",
      resumeReason: "timeout",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "finish this" }],
          timestamp: staleNowMs,
        } as PiMessage,
      ],
    });
    await persistActiveTurn(conversationId, sessionId);
    await wakePausedTurn(
      {
        conversationId,
        destination: SLACK_DESTINATION,
        turnId: sessionId,
        expectedVersion: 1,
      },
      { queue, nowMs: staleNowMs },
    );
    queue.clearSentRecords();
    vi.setSystemTime(TEST_NOW_MS);

    const waitUntil = createWaitUntilCollector();
    const response = await testHeartbeat(
      new Request("https://example.invalid/api/internal/heartbeat", {
        headers: { authorization: "Bearer heartbeat-secret" },
      }),
      waitUntil.fn,
      { conversationWorkQueue: queue },
    );

    expect(response.status).toBe(202);
    await waitUntil.flush();
    expect(queue.sentRecords()).toEqual([
      {
        conversationId,
        idempotencyKey: `heartbeat:pending:${conversationId}:${TEST_NOW_MS}`,
      },
    ]);
    await expect(
      getConversationWorkState({ conversationId }),
    ).resolves.toMatchObject({
      conversationId,
      needsRun: true,
    });
  });

  it("reschedules stale cooperative yield continuation records", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const conversationId = "slack:C123:1712345.0008";
    const sessionId = "turn-yield";
    const staleNowMs = TEST_NOW_MS - 3 * 60 * 1000;
    vi.setSystemTime(staleNowMs);
    await upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 1,
      destination: SLACK_DESTINATION,
      state: "paused",
      resumeReason: "yield",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "keep going" }],
          timestamp: staleNowMs,
        } as PiMessage,
      ],
    });
    await persistActiveTurn(conversationId, sessionId);
    await wakePausedTurn(
      {
        conversationId,
        destination: SLACK_DESTINATION,
        turnId: sessionId,
        expectedVersion: 1,
      },
      { queue, nowMs: staleNowMs },
    );
    queue.clearSentRecords();
    vi.setSystemTime(TEST_NOW_MS);

    const waitUntil = createWaitUntilCollector();
    const response = await testHeartbeat(
      new Request("https://example.invalid/api/internal/heartbeat", {
        headers: { authorization: "Bearer heartbeat-secret" },
      }),
      waitUntil.fn,
      { conversationWorkQueue: queue },
    );

    expect(response.status).toBe(202);
    await waitUntil.flush();
    expect(queue.sentRecords()).toEqual([
      {
        conversationId,
        idempotencyKey: `heartbeat:pending:${conversationId}:${TEST_NOW_MS}`,
      },
    ]);
    await expect(
      getConversationWorkState({ conversationId }),
    ).resolves.toMatchObject({
      conversationId,
      needsRun: true,
    });
  });

  it("skips stale paused turn records for inactive runs", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const conversationId = "slack:C123:1712345.0007";
    const sessionId = "turn-timeout-inactive";
    const staleNowMs = TEST_NOW_MS - 3 * 60 * 1000;
    vi.setSystemTime(staleNowMs);
    await upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      destination: SLACK_DESTINATION,
      state: "paused",
      resumeReason: "timeout",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "finish this" }],
          timestamp: staleNowMs,
        } as PiMessage,
      ],
    });
    await persistActiveTurn(conversationId, "turn-newer");
    vi.setSystemTime(TEST_NOW_MS);

    const waitUntil = createWaitUntilCollector();
    const response = await testHeartbeat(
      new Request("https://example.invalid/api/internal/heartbeat", {
        headers: { authorization: "Bearer heartbeat-secret" },
      }),
      waitUntil.fn,
      { conversationWorkQueue: queue },
    );

    expect(response.status).toBe(202);
    await waitUntil.flush();
    expect(queue.sentRecords()).toEqual([]);
    await expect(getConversationWorkState({ conversationId })).resolves.toBe(
      undefined,
    );
  });

  it("does not scan stale paused turn records outside active conversation work", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const conversationId = "slack:C123:1712345.0009";
    const sessionId = "turn-timeout-no-active-work";
    const staleNowMs = TEST_NOW_MS - 3 * 60 * 1000;
    vi.setSystemTime(staleNowMs);
    await upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      destination: SLACK_DESTINATION,
      state: "paused",
      resumeReason: "timeout",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "finish this" }],
          timestamp: staleNowMs,
        } as PiMessage,
      ],
    });
    await persistActiveTurn(conversationId, sessionId);
    vi.setSystemTime(TEST_NOW_MS);

    const waitUntil = createWaitUntilCollector();
    const response = await testHeartbeat(
      new Request("https://example.invalid/api/internal/heartbeat", {
        headers: { authorization: "Bearer heartbeat-secret" },
      }),
      waitUntil.fn,
      { conversationWorkQueue: queue },
    );

    expect(response.status).toBe(202);
    await waitUntil.flush();
    expect(queue.sentRecords()).toEqual([]);
    await expect(getConversationWorkState({ conversationId })).resolves.toBe(
      undefined,
    );
  });

  it("scopes dispatch lookup to the plugin that created it", async () => {
    const fetchMock = vi.fn(
      async () => new Response("Accepted", { status: 202 }),
    );
    global.fetch = fetchMock as typeof fetch;

    const schedulerCtx = createTestHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });
    const result = await schedulerCtx.agent.dispatch({
      idempotencyKey: "run-1",
      destination: SLACK_DESTINATION,
      destinationVisibility: "private",
      input: "Run the scheduled automation.",
      metadata: { runId: "run-1" },
    });

    await expect(schedulerCtx.agent.get(result.id)).resolves.toEqual({
      id: result.id,
      status: "pending",
    });
    await expect(
      createTestHeartbeatContext({
        plugin: "other-plugin",
        nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      }).agent.get(result.id),
    ).resolves.toBeUndefined();

    await expect(getDispatchRecord(result.id)).resolves.toMatchObject({
      input: "Run the scheduled automation.",
      destination: { channelId: "C123" },
      metadata: { runId: "run-1" },
      source: { kind: "plugin_dispatch" },
    });
  });

  it("keeps plugin state isolated when plugin names and keys contain delimiters", async () => {
    const first = createTestHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });
    const second = createTestHeartbeatContext({
      plugin: "scheduler:run",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });

    await first.state.set("run:1", "first");
    await second.state.set("1", "second");

    await expect(first.state.get("run:1")).resolves.toBe("first");
    await expect(second.state.get("1")).resolves.toBe("second");
  });

  it("bounds dispatch fanout from one heartbeat context", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;

    const ctx = createTestHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });

    for (let index = 0; index < 25; index += 1) {
      await ctx.agent.dispatch({
        idempotencyKey: `run-${index}`,
        destination: SLACK_DESTINATION,
        destinationVisibility: "private",
        input: "Run the scheduled automation.",
      });
    }

    await expect(
      ctx.agent.dispatch({
        idempotencyKey: "run-over-limit",
        destination: SLACK_DESTINATION,
        destinationVisibility: "private",
        input: "Run the scheduled automation.",
      }),
    ).rejects.toThrow("Plugin heartbeat exceeded the dispatch limit");
  });

  it("does not count invalid dispatch requests against heartbeat fanout", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;

    const ctx = createTestHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });

    for (let index = 0; index < 25; index += 1) {
      await expect(
        ctx.agent.dispatch({
          idempotencyKey: `invalid-${index}`,
          destination: {
            platform: "slack",
            teamId: "not-a-team",
            channelId: "C123",
          },
          destinationVisibility: "private",
          input: "Run the scheduled automation.",
        }),
      ).rejects.toThrow("Dispatch destination teamId must be a Slack team id");
    }

    await expect(
      ctx.agent.dispatch({
        idempotencyKey: "valid-after-invalid",
        destination: SLACK_DESTINATION,
        destinationVisibility: "private",
        input: "Run the scheduled automation.",
      }),
    ).resolves.toMatchObject({ status: "created" });
  });

  it("rejects plugin credential subjects that include runtime bindings", async () => {
    const ctx = createTestHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });

    await expect(
      ctx.agent.dispatch({
        idempotencyKey: "run-delegated-mismatch",
        credentialSubject: {
          ...createCredentialSubject(),
          binding: {
            type: "slack-direct-conversation",
            teamId: "T123",
            channelId: "D999",
            signature: "v1=test",
          },
        } as any,
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "D123",
        },
        destinationVisibility: "private",
        input: "Run the scheduled automation.",
      }),
    ).rejects.toThrow("Dispatch credentialSubject binding is runtime-owned");
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(0);
  });

  it("binds delegated credential subjects before persistence", async () => {
    const ctx = createTestHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });

    const result = await ctx.agent.dispatch({
      idempotencyKey: "run-delegated",
      credentialSubject: createCredentialSubject(),
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "D123",
      },
      destinationVisibility: "private",
      input: "Run the scheduled automation.",
    });

    await expect(getDispatchRecord(result.id)).resolves.toMatchObject({
      credentialSubject: {
        type: "user",
        userId: "U123",
        allowedWhen: "private-direct-conversation",
        binding: {
          type: "slack-direct-conversation",
          teamId: "T123",
          channelId: "D123",
          signature: expect.any(String),
        },
      },
    });
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(0);
  });
});
