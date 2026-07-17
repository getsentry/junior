import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSlackSource,
  defineJuniorPlugin,
  type Destination,
  type Source,
} from "@sentry/junior-plugin-api";
import { createHeartbeatContext } from "@/chat/agent-dispatch/context";
import { recoverStaleDispatches } from "@/chat/agent-dispatch/heartbeat";
import {
  createSchedulerSqlStore,
  schedulerPlugin,
  type ScheduledTask,
  type SchedulerDb,
} from "@sentry/junior-scheduler";
import { getDb } from "@/chat/db";
import {
  createOrGetDispatch,
  getDispatchRecord,
  getDispatchStorageKey,
  listIncompleteDispatchIds,
  updateDispatchRecord,
  withDispatchLock,
} from "@/chat/agent-dispatch/store";
import type { DispatchRecord } from "@/chat/agent-dispatch/types";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { scheduleAgentContinue } from "@/chat/services/agent-continue";
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
const TEST_RUN_AT_MS = Date.parse("2026-05-26T12:00:00.000Z");
const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} satisfies Destination;
const SLACK_SOURCE = createSlackSource({
  ...SLACK_DESTINATION,
  type: "priv",
}) satisfies Source;

function slackDmSource(channelId = "D123"): Source {
  return createSlackSource({
    teamId: "T123",
    channelId,

    type: "priv",
  });
}

let schedulerDb: SchedulerDb | undefined;

async function useSchedulerSqlStore() {
  schedulerDb = getDb() as unknown as SchedulerDb;
  return createSchedulerSqlStore(schedulerDb);
}

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const nextRunAtMs = TEST_RUN_AT_MS;
  return {
    id: "sched_plugin_1",
    conversationAccess: { audience: "channel", visibility: "public" },
    createdAtMs: nextRunAtMs,
    createdBy: { slackUserId: "U123" },
    credentialMode: "system",
    destination: SLACK_DESTINATION,
    nextRunAtMs,
    schedule: {
      description: "Once at noon",
      kind: "one_off",
      timezone: "UTC",
    },
    status: "active",
    task: {
      text: "Post a digest. Summarize the latest state.",
    },
    updatedAtMs: nextRunAtMs,
    ...overrides,
  };
}

function createDailyTask(
  overrides: Partial<ScheduledTask> = {},
): ScheduledTask {
  const nextRunAtMs = Date.parse("2026-05-24T12:00:00.000Z");
  return createTask({
    id: "sched_plugin_daily",
    createdAtMs: nextRunAtMs,
    nextRunAtMs,
    schedule: {
      description: "Daily at noon UTC",
      kind: "recurring",
      timezone: "UTC",
      recurrence: {
        frequency: "daily",
        interval: 1,
        startDate: "2026-05-24",
        time: {
          hour: 12,
          minute: 0,
        },
      },
    },
    updatedAtMs: nextRunAtMs,
    ...overrides,
  });
}

function mockDispatchCallbackFetch(originalFetch: typeof fetch) {
  const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
    const input = args[0];
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith("https://slack.com/api/")) {
      return await originalFetch(...args);
    }
    return new Response("Accepted", { status: 202 });
  });
  global.fetch = fetchMock as typeof fetch;
  return fetchMock;
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
      backfill: {},
      compactions: [],
      messages: [],
      processing: {
        activeTurnId,
      },
      stats: {
        compactedMessageCount: 0,
        estimatedContextTokens: 0,
        totalMessageCount: 0,
        updatedAtMs: TEST_NOW_MS,
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
    schedulerDb = undefined;
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
    const response = await heartbeat(
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
    const response = await heartbeat(
      new Request("https://example.invalid/api/internal/heartbeat", {
        headers: { authorization: "Bearer heartbeat-secret" },
      }),
      waitUntil.fn,
    );

    expect(response.status).toBe(202);
    await waitUntil.flush();
    expect(seen).toHaveLength(1);
  });

  it("reschedules stale agent continuation records", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const conversationId = "slack:C123:1712345.0001";
    const sessionId = "turn-timeout";
    const staleNowMs = TEST_NOW_MS - 3 * 60 * 1000;
    vi.setSystemTime(staleNowMs);
    await upsertAgentTurnSessionRecord({
      modelId: "test/model",
      conversationId,
      sessionId,
      sliceId: 2,
      destination: SLACK_DESTINATION,
      state: "awaiting_resume",
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
    await scheduleAgentContinue(
      {
        conversationId,
        destination: SLACK_DESTINATION,
        sessionId,
        expectedVersion: 1,
      },
      { queue, nowMs: staleNowMs },
    );
    queue.clearSentRecords();
    vi.setSystemTime(TEST_NOW_MS);

    const waitUntil = createWaitUntilCollector();
    const response = await heartbeat(
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
        destination: SLACK_DESTINATION,
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
    await upsertAgentTurnSessionRecord({
      modelId: "test/model",
      conversationId,
      sessionId,
      sliceId: 1,
      destination: SLACK_DESTINATION,
      state: "awaiting_resume",
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
    await scheduleAgentContinue(
      {
        conversationId,
        destination: SLACK_DESTINATION,
        sessionId,
        expectedVersion: 1,
      },
      { queue, nowMs: staleNowMs },
    );
    queue.clearSentRecords();
    vi.setSystemTime(TEST_NOW_MS);

    const waitUntil = createWaitUntilCollector();
    const response = await heartbeat(
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
        destination: SLACK_DESTINATION,
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

  it("skips stale agent continuation records for inactive runs", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const conversationId = "slack:C123:1712345.0007";
    const sessionId = "turn-timeout-inactive";
    const staleNowMs = TEST_NOW_MS - 3 * 60 * 1000;
    vi.setSystemTime(staleNowMs);
    await upsertAgentTurnSessionRecord({
      modelId: "test/model",
      conversationId,
      sessionId,
      sliceId: 2,
      destination: SLACK_DESTINATION,
      state: "awaiting_resume",
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
    const response = await heartbeat(
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

  it("does not scan stale agent continuation records outside active conversation work", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const conversationId = "slack:C123:1712345.0009";
    const sessionId = "turn-timeout-no-active-work";
    const staleNowMs = TEST_NOW_MS - 3 * 60 * 1000;
    vi.setSystemTime(staleNowMs);
    await upsertAgentTurnSessionRecord({
      modelId: "test/model",
      conversationId,
      sessionId,
      sliceId: 2,
      destination: SLACK_DESTINATION,
      state: "awaiting_resume",
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
    const response = await heartbeat(
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
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;

    const schedulerCtx = createHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });
    const result = await schedulerCtx.agent.dispatch({
      idempotencyKey: "run-1",
      destination: SLACK_DESTINATION,
      destinationVisibility: "private",
      input: "Run the scheduled task.",
      metadata: { runId: "run-1" },
      source: SLACK_SOURCE,
    });

    await expect(schedulerCtx.agent.get(result.id)).resolves.toEqual({
      id: result.id,
      status: "pending",
    });
    await expect(
      createHeartbeatContext({
        plugin: "other-plugin",
        nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      }).agent.get(result.id),
    ).resolves.toBeUndefined();

    await expect(getDispatchRecord(result.id)).resolves.toMatchObject({
      input: "Run the scheduled task.",
      destination: { channelId: "C123" },
      metadata: { runId: "run-1" },
      source: { channelId: "C123" },
    });
  });

  it("keeps plugin state isolated when plugin names and keys contain delimiters", async () => {
    const first = createHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });
    const second = createHeartbeatContext({
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

    const ctx = createHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });

    for (let index = 0; index < 25; index += 1) {
      await ctx.agent.dispatch({
        idempotencyKey: `run-${index}`,
        destination: SLACK_DESTINATION,
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        source: SLACK_SOURCE,
      });
    }

    await expect(
      ctx.agent.dispatch({
        idempotencyKey: "run-over-limit",
        destination: SLACK_DESTINATION,
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        source: SLACK_SOURCE,
      }),
    ).rejects.toThrow("Plugin heartbeat exceeded the dispatch limit");
  });

  it("does not count invalid dispatch requests against heartbeat fanout", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;

    const ctx = createHeartbeatContext({
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
          input: "Run the scheduled task.",
          source: SLACK_SOURCE,
        }),
      ).rejects.toThrow("Dispatch destination teamId must be a Slack team id");
    }

    await expect(
      ctx.agent.dispatch({
        idempotencyKey: "valid-after-invalid",
        destination: SLACK_DESTINATION,
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        source: SLACK_SOURCE,
      }),
    ).resolves.toMatchObject({ status: "created" });
  });

  it("rejects plugin credential subjects that include runtime bindings", async () => {
    mockDispatchCallbackFetch(originalFetch);

    const ctx = createHeartbeatContext({
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
        input: "Run the scheduled task.",
        source: slackDmSource(),
      }),
    ).rejects.toThrow("Dispatch credentialSubject binding is runtime-owned");
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(0);
    await expect(listIncompleteDispatchIds()).resolves.toEqual([]);
  });

  it("binds delegated credential subjects before persistence", async () => {
    mockDispatchCallbackFetch(originalFetch);
    const ctx = createHeartbeatContext({
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
      input: "Run the scheduled task.",
      source: slackDmSource(),
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

  it("fails stale dispatches that exceed retry attempts", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-exhausted",
        destination: SLACK_DESTINATION,
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        source: SLACK_SOURCE,
      },
    });
    await withDispatchLock(created.record.id, async (state) => {
      const record = await state.get<DispatchRecord>(
        getDispatchStorageKey(created.record.id),
      );
      if (!record) {
        throw new Error("Expected dispatch record to exist");
      }
      await updateDispatchRecord(state, {
        ...record,
        attempt: record.maxAttempts,
        lastCallbackAtMs: Date.parse("2026-05-26T12:00:00.000Z"),
      });
    });

    await expect(
      recoverStaleDispatches({
        nowMs: Date.parse("2026-05-26T12:05:00.000Z"),
      }),
    ).resolves.toBe(0);
    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "failed",
      errorMessage: "Dispatch exceeded retry attempts.",
    });
  });

  it("fails stale dispatches when the locked row no longer parses", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-exhausted-corrupt-row",
        destination: SLACK_DESTINATION,
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        source: SLACK_SOURCE,
      },
    });
    await withDispatchLock(created.record.id, async (state) => {
      const record = await state.get<DispatchRecord>(
        getDispatchStorageKey(created.record.id),
      );
      if (!record) {
        throw new Error("Expected dispatch record to exist");
      }
      await updateDispatchRecord(state, {
        ...record,
        attempt: record.maxAttempts,
        lastCallbackAtMs: Date.parse("2026-05-26T12:00:00.000Z"),
      });
    });

    const state = getStateAdapter();
    await state.connect();
    const storageKey = getDispatchStorageKey(created.record.id);
    const current = await state.get<DispatchRecord>(storageKey);
    if (!current) {
      throw new Error("Expected dispatch record to exist");
    }
    const corruptRecord = {
      ...(current as unknown as Record<string, unknown>),
    };
    delete corruptRecord.destination;
    const originalGet = state.get.bind(state);
    let recordReads = 0;
    state.get = (async (key: string) => {
      if (key === storageKey && recordReads++ === 1) {
        return corruptRecord;
      }
      return await originalGet(key);
    }) as typeof state.get;

    try {
      await expect(
        recoverStaleDispatches({
          nowMs: Date.parse("2026-05-26T12:05:00.000Z"),
        }),
      ).resolves.toBe(0);
    } finally {
      state.get = originalGet;
    }

    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "failed",
      errorMessage: "Dispatch exceeded retry attempts.",
    });
  });

  it("removes terminal dispatches from the recovery index", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-terminal-index",
        destination: SLACK_DESTINATION,
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        source: SLACK_SOURCE,
      },
    });

    await expect(listIncompleteDispatchIds()).resolves.toContain(
      created.record.id,
    );

    await withDispatchLock(created.record.id, async (state) => {
      const record = await state.get<DispatchRecord>(
        getDispatchStorageKey(created.record.id),
      );
      if (!record) {
        throw new Error("missing dispatch record");
      }
      await updateDispatchRecord(state, {
        ...record,
        status: "completed",
      });
    });

    await expect(listIncompleteDispatchIds()).resolves.not.toContain(
      created.record.id,
    );
  });

  it("does not fail an active leased dispatch that reached max attempts", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-active-max-attempts",
        destination: SLACK_DESTINATION,
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        source: SLACK_SOURCE,
      },
    });
    await withDispatchLock(created.record.id, async (state) => {
      const record = await state.get<DispatchRecord>(
        getDispatchStorageKey(created.record.id),
      );
      if (!record) {
        throw new Error("Expected dispatch record to exist");
      }
      await updateDispatchRecord(state, {
        ...record,
        attempt: record.maxAttempts,
        lastCallbackAtMs: Date.parse("2026-05-26T12:00:00.000Z"),
        leaseExpiresAtMs: Date.parse("2026-05-26T12:10:00.000Z"),
        status: "running",
      });
    });

    await expect(
      recoverStaleDispatches({
        nowMs: Date.parse("2026-05-26T12:05:00.000Z"),
      }),
    ).resolves.toBe(0);
    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "running",
      attempt: created.record.maxAttempts,
    });
  });

  it("dispatches and reconciles scheduled runs from the scheduler plugin", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;
    setPlugins([schedulerPlugin()]);
    const store = await useSchedulerSqlStore();
    await store.saveTask(
      createTask({
        createdBy: {
          slackUserId: "U039RR91S",
          userName: "U039RR91S",
          fullName: "W039RR91S",
        },
        schedule: {
          description: "Once\nat noon",
          kind: "one_off",
          timezone: "UTC",
        },
      }),
    );

    const firstWaitUntil = createWaitUntilCollector();
    const firstResponse = await heartbeat(
      new Request("https://example.invalid/api/internal/heartbeat", {
        headers: { authorization: "Bearer heartbeat-secret" },
      }),
      firstWaitUntil.fn,
    );
    expect(firstResponse.status).toBe(202);
    await firstWaitUntil.flush();

    const running = await store.getRun(`sched_plugin_1:${TEST_RUN_AT_MS}`);
    expect(running).toMatchObject({
      status: "running",
      dispatchId: expect.any(String),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const dispatchRecord = await getDispatchRecord(running!.dispatchId!);
    expect(dispatchRecord?.input).toBe(
      "Post a digest. Summarize the latest state.",
    );
    expect(dispatchRecord?.destination).toEqual(SLACK_DESTINATION);
    expect(dispatchRecord?.source).toEqual(
      createSlackSource({
        teamId: "T123",
        channelId: "C123",

        type: "priv",
      }),
    );
    expect(dispatchRecord?.metadata).toMatchObject({
      creatorSlackUserId: "U039RR91S",
      runId: `sched_plugin_1:${TEST_RUN_AT_MS}`,
      schedule: "Once at noon",
      scheduleKind: "one_off",
      scheduledFor: "2026-05-26T12:00:00.000Z",
      runningAt: "2026-05-26T12:05:00.000Z",
      taskId: "sched_plugin_1",
      timezone: "UTC",
    });
    expect(dispatchRecord?.metadata).not.toHaveProperty("creatorUserName");
    expect(dispatchRecord?.metadata).not.toHaveProperty("creatorFullName");

    await withDispatchLock(running!.dispatchId!, async (state) => {
      const record = await state.get<DispatchRecord>(
        getDispatchStorageKey(running!.dispatchId!),
      );
      if (!record) {
        throw new Error("Expected dispatch record to exist");
      }
      await updateDispatchRecord(state, {
        ...record,
        resultMessageTs: "1700000000.000001",
        status: "completed",
      });
    });

    const secondWaitUntil = createWaitUntilCollector();
    const secondResponse = await heartbeat(
      new Request("https://example.invalid/api/internal/heartbeat", {
        headers: { authorization: "Bearer heartbeat-secret" },
      }),
      secondWaitUntil.fn,
    );
    expect(secondResponse.status).toBe(202);
    await secondWaitUntil.flush();

    await expect(store.getRun(running!.id)).resolves.toMatchObject({
      status: "completed",
      resultMessageTs: "1700000000.000001",
    });
    await expect(store.getTask("sched_plugin_1")).resolves.toMatchObject({
      lastRunAtMs: Date.parse("2026-05-26T12:00:00.000Z"),
      status: "paused",
    });
  }, 30_000);

  it("exposes sanitized scheduler operational reports through Junior reporting", async () => {
    setPlugins([schedulerPlugin()]);
    const store = await useSchedulerSqlStore();
    await store.saveTask(
      createTask({
        createdBy: {
          slackUserId: "U123",
          fullName: "Alice Reviewer",
          userName: "alice",
        },
        task: {
          text: "Secret task text that must stay out of dashboard stats.",
        },
      }),
    );
    await store.saveTask(
      createTask({
        createdBy: {
          slackUserId: "U456",
          fullName: "W039RR91S",
          userName: "U456",
        },
        id: "sched_plugin_blocked",
        status: "blocked",
        statusReason: "Secret blocked reason",
        task: {
          text: "Secret blocked task text",
        },
        updatedAtMs: TEST_NOW_MS,
      }),
    );
    const { readPluginOperationalReportFeed } = await import("@/reporting");
    const feed = await readPluginOperationalReportFeed();
    const scheduler = feed.reports.find(
      (report) => report.pluginName === "scheduler",
    );

    expect(feed.source).toBe("plugins");
    expect(scheduler).toMatchObject({
      pluginName: "scheduler",
      title: "Scheduler",
    });
    expect(scheduler?.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "active", value: "1" }),
        expect.objectContaining({ label: "blocked", value: "1" }),
        expect.objectContaining({ label: "due now", value: "1" }),
      ]),
    );
    expect(scheduler?.recordSets?.map((recordSet) => recordSet.title)).toEqual([
      "Upcoming",
      "Blocked",
      "Running",
    ]);
    expect(scheduler?.recordSets?.[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "author", label: "Author" }),
      ]),
    );
    expect(
      scheduler?.recordSets?.[0]?.records?.[0]?.values ?? {},
    ).toMatchObject({
      author: "Alice Reviewer (@alice)",
    });
    const blockedRecords = scheduler?.recordSets?.[1]?.records ?? [];
    expect(
      blockedRecords.find((record) => record.id === "sched_plugin_blocked")
        ?.values ?? {},
    ).toMatchObject({
      author: "Slack User U456",
    });
    expect(JSON.stringify(feed)).not.toContain("Secret");
  }, 30_000);

  it("counts all running scheduler runs in operational summaries", async () => {
    setPlugins([schedulerPlugin()]);
    const store = await useSchedulerSqlStore();
    for (let index = 0; index < 6; index += 1) {
      await store.saveTask(
        createTask({
          id: `sched_running_${index}`,
          createdAtMs: TEST_RUN_AT_MS + index,
          updatedAtMs: TEST_RUN_AT_MS + index,
        }),
      );
    }
    for (let index = 0; index < 6; index += 1) {
      await expect(
        store.claimDueRun({ nowMs: TEST_NOW_MS + index }),
      ).resolves.toBeDefined();
    }

    const { readPluginOperationalReportFeed } = await import("@/reporting");
    const feed = await readPluginOperationalReportFeed();
    const scheduler = feed.reports.find(
      (report) => report.pluginName === "scheduler",
    );
    const runningSummary = scheduler?.metrics?.find(
      (metric) => metric.label === "running",
    );
    const runningSection = scheduler?.recordSets?.find(
      (recordSet) => recordSet.title === "Running",
    );

    expect(runningSummary).toMatchObject({ value: "6" });
    expect(runningSection?.records).toHaveLength(5);
  }, 30_000);

  it.each([
    {
      conversationAccess: {
        audience: "channel",
        visibility: "public",
      } as const,
      destination: SLACK_DESTINATION,
      label: "channel",
    },
    {
      conversationAccess: {
        audience: "direct",
        visibility: "private",
      } as const,
      destination: { ...SLACK_DESTINATION, channelId: "D123" },
      label: "DM",
    },
  ])(
    "binds creator credentials to the scheduled task dispatch in a $label",
    async ({ conversationAccess, destination }) => {
      mockDispatchCallbackFetch(originalFetch);
      setPlugins([schedulerPlugin()]);
      const store = await useSchedulerSqlStore();
      await store.saveTask(
        createTask({
          conversationAccess,
          credentialMode: "creator",
          destination,
        }),
      );

      const waitUntil = createWaitUntilCollector();
      const response = await heartbeat(
        new Request("https://example.invalid/api/internal/heartbeat", {
          headers: { authorization: "Bearer heartbeat-secret" },
        }),
        waitUntil.fn,
      );
      expect(response.status).toBe(202);
      await waitUntil.flush();

      const running = await store.getRun(`sched_plugin_1:${TEST_RUN_AT_MS}`);
      expect(running?.dispatchId).toEqual(expect.any(String));
      await expect(
        getDispatchRecord(running!.dispatchId!),
      ).resolves.toMatchObject({
        credentialSubject: {
          type: "user",
          userId: "U123",
          allowedWhen: "scheduled-task",
          taskId: "sched_plugin_1",
          binding: {
            type: "scheduled-task",
            plugin: "scheduler",
            taskId: "sched_plugin_1",
            signature: expect.any(String),
          },
        },
        destination,
      });
      expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(0);
    },
    30_000,
  );

  it("fails scheduled runs when their dispatch record disappeared", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;
    setPlugins([schedulerPlugin()]);
    const store = await useSchedulerSqlStore();
    await store.saveTask(createTask());

    const firstWaitUntil = createWaitUntilCollector();
    const firstResponse = await heartbeat(
      new Request("https://example.invalid/api/internal/heartbeat", {
        headers: { authorization: "Bearer heartbeat-secret" },
      }),
      firstWaitUntil.fn,
    );
    expect(firstResponse.status).toBe(202);
    await firstWaitUntil.flush();

    const running = await store.getRun(`sched_plugin_1:${TEST_RUN_AT_MS}`);
    expect(running).toMatchObject({
      status: "running",
      dispatchId: expect.any(String),
    });
    const state = getStateAdapter();
    await state.connect();
    await state.delete(getDispatchStorageKey(running!.dispatchId!));

    const secondWaitUntil = createWaitUntilCollector();
    const secondResponse = await heartbeat(
      new Request("https://example.invalid/api/internal/heartbeat", {
        headers: { authorization: "Bearer heartbeat-secret" },
      }),
      secondWaitUntil.fn,
    );
    expect(secondResponse.status).toBe(202);
    await secondWaitUntil.flush();

    await expect(store.getRun(running!.id)).resolves.toMatchObject({
      status: "failed",
      errorMessage: "Scheduled task dispatch record is missing.",
    });
    await expect(store.getTask("sched_plugin_1")).resolves.toMatchObject({
      status: "paused",
    });
  }, 30_000);

  it("blocks malformed scheduled tasks without stopping the scheduler plugin heartbeat", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;
    setPlugins([schedulerPlugin()]);
    const store = await useSchedulerSqlStore();
    await store.saveTask({
      ...createTask(),
      id: "sched_plugin_malformed",
      task: {
        text: "",
      },
    });

    const waitUntil = createWaitUntilCollector();
    const response = await heartbeat(
      new Request("https://example.invalid/api/internal/heartbeat", {
        headers: { authorization: "Bearer heartbeat-secret" },
      }),
      waitUntil.fn,
    );
    expect(response.status).toBe(202);
    await waitUntil.flush();

    await expect(
      store.getRun(`sched_plugin_malformed:${TEST_RUN_AT_MS}`),
    ).resolves.toMatchObject({
      status: "blocked",
      errorMessage: expect.stringContaining(
        "Scheduled task dispatch metadata could not be built",
      ),
    });
    await expect(
      store.getTask("sched_plugin_malformed"),
    ).resolves.toMatchObject({
      status: "blocked",
      statusReason: expect.stringContaining(
        "Scheduled task dispatch metadata could not be built",
      ),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30_000);

  it("skips old recurring occurrences and advances to the next future run", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;
    setPlugins([schedulerPlugin()]);
    const store = await useSchedulerSqlStore();
    const task = createDailyTask();
    await store.saveTask(task);

    const waitUntil = createWaitUntilCollector();
    const response = await heartbeat(
      new Request("https://example.invalid/api/internal/heartbeat", {
        headers: { authorization: "Bearer heartbeat-secret" },
      }),
      waitUntil.fn,
    );
    expect(response.status).toBe(202);
    await waitUntil.flush();

    await expect(
      store.getRun(`${task.id}:${task.nextRunAtMs}`),
    ).resolves.toMatchObject({
      status: "skipped",
      errorMessage: expect.stringContaining("more than 24 hours late"),
    });
    await expect(store.getTask(task.id)).resolves.toMatchObject({
      status: "active",
      nextRunAtMs: Date.parse("2026-05-27T12:00:00.000Z"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30_000);

  it("dedupes equivalent old recurring tasks during heartbeat recovery", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;
    setPlugins([schedulerPlugin()]);
    const store = await useSchedulerSqlStore();
    const first = createDailyTask({
      id: "sched_plugin_duplicate_a",
      createdAtMs: Date.parse("2026-05-24T12:00:00.000Z"),
    });
    const duplicate = createDailyTask({
      id: "sched_plugin_duplicate_b",
      createdAtMs: Date.parse("2026-05-24T12:00:01.000Z"),
    });
    await store.saveTask(first);
    await store.saveTask(duplicate);

    const waitUntil = createWaitUntilCollector();
    const response = await heartbeat(
      new Request("https://example.invalid/api/internal/heartbeat", {
        headers: { authorization: "Bearer heartbeat-secret" },
      }),
      waitUntil.fn,
    );
    expect(response.status).toBe(202);
    await waitUntil.flush();

    await expect(
      store.getRun(`${duplicate.id}:${duplicate.nextRunAtMs}`),
    ).resolves.toMatchObject({
      status: "skipped",
      errorMessage: expect.stringContaining(
        "Duplicate stale scheduled task was skipped",
      ),
    });
    await expect(store.getTask(first.id)).resolves.toMatchObject({
      status: "active",
      nextRunAtMs: Date.parse("2026-05-27T12:00:00.000Z"),
    });
    const duplicateTask = await store.getTask(duplicate.id);
    expect(duplicateTask).toMatchObject({
      status: "paused",
      statusReason: expect.stringContaining(first.id),
    });
    expect(duplicateTask).not.toHaveProperty("nextRunAtMs");
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30_000);
});
