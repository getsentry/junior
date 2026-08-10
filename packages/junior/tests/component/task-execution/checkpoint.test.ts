import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSlackSource,
  type Destination,
  type Source,
} from "@sentry/junior-plugin-api";
import type { ConversationStore } from "@/chat/conversations/store";
import type { PiMessage } from "@/chat/pi/messages";
import { historyItemFromPiMessage } from "@/chat/pi/conversation-events";
import { buildAgentsInstructionsMessage } from "@/chat/repository-instructions";

const ORIGINAL_ENV = { ...process.env };
const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const satisfies Destination;
const SLACK_SOURCE = createSlackSource({
  teamId: "T123",
  channelId: "C123",
  threadTs: "1700000000.001",
  visibility: "private",
}) satisfies Source;

function userMessage(text: string): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function assistantMessage(text: string, timestamp: number): PiMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp,
  } as PiMessage;
}

function failingConversationStore(): ConversationStore {
  return {
    createChild: vi.fn(),
    get: vi.fn(),
    getConversationIdByProviderConversation: vi.fn(async () => undefined),
    bindProviderConversation: vi.fn(),
    getDestinationVisibility: vi.fn(async () => undefined),
    recordActivity: vi.fn(async () => {
      throw new Error("conversation metadata unavailable");
    }),
    recordExecution: vi.fn(),
    listByActivity: vi.fn(),
  };
}

describe("turn checkpoint", () => {
  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
    };
    vi.resetModules();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
    vi.doUnmock("@/chat/logging");
    vi.doUnmock("@/chat/task-execution/turn-cursor");
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("keeps unfinished turn sessions for one day and terminal sessions for one hour", async () => {
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const { upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");
    const stateAdapter = getStateAdapter();
    const set = vi.spyOn(stateAdapter, "set");
    const appendToList = vi.spyOn(stateAdapter, "appendToList");

    const runtimeContext = buildAgentsInstructionsMessage({
      text: "repo instructions",
    });
    await upsertTurnRecord({
      conversationId: "local:ttl-split:turn",
      piMessages: [runtimeContext],
      turnId: "turn-ttl-split",
      sliceId: 1,
      state: "running",
    });
    expect(set.mock.calls.at(-1)?.[1]).toMatchObject({
      runtimeContext: [runtimeContext],
    });
    expect(set.mock.calls.at(-1)?.[1]).not.toHaveProperty("modelId");
    expect(set.mock.calls.at(-1)?.[2]).toBe(24 * 60 * 60 * 1000);
    expect(appendToList).toHaveBeenCalledTimes(1);
    expect(appendToList.mock.calls[0]?.[0]).toBe(
      "junior:turn_cursor:v2:conversation:local:ttl-split:turn:index",
    );
    // Recovery index stays on the resume window so terminal writes cannot
    // expire unfinished sibling summaries.
    expect(appendToList.mock.calls[0]?.[2]?.ttlMs).toBe(24 * 60 * 60 * 1000);

    set.mockClear();
    appendToList.mockClear();
    await upsertTurnRecord({
      conversationId: "local:ttl-split:turn",
      piMessages: [runtimeContext],
      turnId: "turn-ttl-split",
      sliceId: 1,
      state: "completed",
    });
    expect(set.mock.calls.at(-1)?.[1]).not.toHaveProperty("runtimeContext");
    expect(set.mock.calls.at(-1)?.[2]).toBe(60 * 60 * 1000);
    expect(appendToList).toHaveBeenCalledTimes(1);
    expect(appendToList.mock.calls[0]?.[2]?.ttlMs).toBe(24 * 60 * 60 * 1000);
  });

  it.each([
    {
      name: "the summary is terminal",
      cursorState: "running",
      summaryState: "completed",
    },
    {
      name: "the cursor is terminal",
      cursorState: "completed",
      summaryState: "running",
    },
  ] as const)(
    "does not let delayed progress replace completion when $name",
    async ({ cursorState, summaryState }) => {
      const {
        getTurnRecord,
        listTurnSummaries,
        recordTurnSummary,
        upsertTurnRecord,
      } = await import("@/chat/task-execution/turn-cursor");
      const conversationId = `agent-dispatch:delayed-${cursorState}`;
      const turnId = `dispatch:delayed-${cursorState}`;

      // Cursor and summary writes can finish in either order. A terminal state
      // in either store must prevent delayed progress from changing the result.
      await upsertTurnRecord({
        conversationId,
        turnId,
        sliceId: 1,
        state: cursorState,
        piMessages: [],
      });
      if (cursorState === "completed") {
        const { getStateAdapter } = await import("@/chat/state/adapter");
        const indexKey = `junior:turn_cursor:v2:conversation:${conversationId}:index`;
        const stateAdapter = getStateAdapter();
        await stateAdapter.delete(indexKey);
        await stateAdapter.appendToList(
          indexKey,
          {
            schemaVersion: 2,
            version: 1,
            conversationId,
            turnId,
            sliceId: 1,
            state: summaryState,
            updatedAtMs: Date.now(),
          },
          { ttlMs: 60_000 },
        );
      } else {
        await recordTurnSummary({
          conversationId,
          turnId,
          sliceId: 1,
          state: summaryState,
        });
      }
      await recordTurnSummary({
        conversationId,
        turnId,
        sliceId: 1,
        state: "running",
      });

      await expect(listTurnSummaries(conversationId)).resolves.toEqual([
        expect.objectContaining({ state: summaryState, turnId }),
      ]);
      await expect(getTurnRecord(conversationId, turnId)).resolves.toEqual(
        expect.objectContaining({ state: cursorState, turnId }),
      );
    },
  );

  it("keeps dispatch correlation write-once across session summaries", async () => {
    const { recordTurnSummary } =
      await import("@/chat/task-execution/turn-cursor");
    await recordTurnSummary({
      conversationId: "agent-dispatch:dispatch_one",
      dispatchId: "dispatch_one",
      turnId: "dispatch:dispatch_one",
      sliceId: 1,
      state: "running",
    });

    await expect(
      recordTurnSummary({
        conversationId: "agent-dispatch:dispatch_one",
        dispatchId: "dispatch_other",
        turnId: "dispatch:dispatch_one",
        sliceId: 1,
        state: "completed",
      }),
    ).rejects.toThrow("dispatchId cannot be changed");
  });

  it("reuses the latest stored transcript when the auth pause captured no messages", async () => {
    const { saveTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");
    const { getTurnRecord, upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");

    const priorMessages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "help me" }],
        timestamp: 1,
      },
    ];

    await upsertTurnRecord({
      conversationId: "conversation-1",
      turnId: "turn-1",
      sliceId: 1,
      state: "paused",
      source: SLACK_SOURCE,
      piMessages: priorMessages,
      resumeReason: "auth",
      replyDelivery: "conversation",
      errorMessage: "initial auth pause",
    });

    const authSessionRecord = await saveTurnCheckpoint({
      mode: "paused",
      reason: "auth",
      conversationId: "conversation-1",
      turnId: "turn-1",
      sliceId: 1,
      messages: [],
      errorMessage: "plugin auth pause",
    });

    expect(authSessionRecord?.sliceId).toBe(2);

    const sessionRecord = await getTurnRecord("conversation-1", "turn-1");
    expect(sessionRecord).toMatchObject({
      state: "paused",
      sliceId: 2,
      resumedFromSliceId: 1,
      resumeReason: "auth",
      replyDelivery: "conversation",
      errorMessage: "plugin auth pause",
      piMessages: [priorMessages[0]],
    });
    // Nested routing stays off redis; SQL dual-write is the authority.
    expect(sessionRecord).not.toHaveProperty("source");
    expect(sessionRecord).not.toHaveProperty("destination");
    expect(sessionRecord).not.toHaveProperty("actor");
  });

  it("keeps ops metadata in SQL and out of Redis turn-session records", async () => {
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const { upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");
    const { getConversationStore } = await import("@/chat/db");
    const stateAdapter = getStateAdapter();
    const set = vi.spyOn(stateAdapter, "set");
    const actor = {
      platform: "slack",
      teamId: "T123",
      userId: "U123",
    } as const;
    const usage = { inputTokens: 7, outputTokens: 3 };

    await upsertTurnRecord({
      actor,
      channelName: "runtime-team",
      conversationId: "slack:C123:ops-bag",
      cumulativeDurationMs: 1_500,
      cumulativeUsage: usage,
      destination: SLACK_DESTINATION,
      piMessages: [userMessage("ship it")],
      turnId: "turn-ops-bag",
      sliceId: 1,
      source: SLACK_SOURCE,
      state: "running",
    });

    const redisRecord = set.mock.calls.at(-1)?.[1];
    for (const field of [
      "actors",
      "channelName",
      "cumulativeDurationMs",
      "cumulativeUsage",
      "loadedSkillNames",
      "modelId",
      "reasoningLevel",
    ]) {
      expect(redisRecord).not.toHaveProperty(field);
    }
    await expect(
      getConversationStore().get({ conversationId: "slack:C123:ops-bag" }),
    ).resolves.toMatchObject({
      channelName: "runtime-team",
      executionMetrics: { durationMs: 1_500, usage },
    });
  });

  it("keeps session metrics when a work-lease mirror advances the execution run", async () => {
    const { getConversationStore } = await import("@/chat/db");
    const { getTurnRecord, upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");
    const conversationStore = getConversationStore();
    const conversationId = "local:metrics-work-lease";
    const sessionId = "turn-metrics-work-lease";

    await upsertTurnRecord({
      conversationId,
      cumulativeDurationMs: 1_500,
      cumulativeUsage: { inputTokens: 7 },
      piMessages: [userMessage("metered turn")],
      turnId: sessionId,
      sliceId: 1,
      state: "running",
    });
    const conversation = await conversationStore.get({ conversationId });
    expect(conversation).toBeDefined();
    await conversationStore.recordExecution({
      conversationId,
      createdAtMs: conversation!.createdAtMs,
      execution: {
        runId: "work-lease-mirror",
        status: "running",
        updatedAtMs: conversation!.execution.updatedAtMs! + 1,
      },
      lastActivityAtMs: conversation!.lastActivityAtMs,
      metrics: null,
      updatedAtMs: conversation!.updatedAtMs + 1,
    });

    const recovered = await getTurnRecord(conversationId, sessionId);
    expect(recovered).toMatchObject({
      cumulativeDurationMs: 1_500,
      cumulativeUsage: { inputTokens: 7 },
    });
    await upsertTurnRecord({
      conversationId,
      piMessages: recovered!.piMessages,
      turnId: sessionId,
      sliceId: 2,
      state: "paused",
    });
    await expect(
      conversationStore.get({ conversationId }),
    ).resolves.toMatchObject({
      executionMetrics: {
        durationMs: 1_500,
        runId: sessionId,
        usage: { inputTokens: 7 },
      },
    });
  });

  it("does not inherit metrics from a prior session", async () => {
    const { getConversationStore } = await import("@/chat/db");
    const { recordTurnSummary, upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");
    const conversationStore = getConversationStore();
    const conversationId = "local:metrics-session-scope";

    await recordTurnSummary({
      conversationId,
      cumulativeDurationMs: 1_500,
      cumulativeUsage: { inputTokens: 7 },
      turnId: "turn-first",
      sliceId: 1,
      state: "completed",
    });
    await upsertTurnRecord({
      conversationId,
      piMessages: [userMessage("second")],
      turnId: "turn-second",
      sliceId: 1,
      state: "running",
    });

    await expect(
      conversationStore.get({ conversationId }),
    ).resolves.toMatchObject({
      execution: { runId: "turn-second" },
      executionMetrics: { durationMs: 0 },
    });
  });

  it("records Slack turn activity without replacing confirmed visibility", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const { upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");
    const { getConversationStore } = await import("@/chat/db");
    const { resolveDestinationVisibility } =
      await import("@/chat/conversations/destination-visibility");
    const { appendInboundMessage } =
      await import("@/chat/task-execution/store");
    const conversationStore = getConversationStore();

    try {
      await conversationStore.recordActivity({
        conversationId: "slack:C123:turn-activity",
        destination: SLACK_DESTINATION,
        nowMs: 8_000,
        source: "slack",
        visibility: "public",
      });
      await appendInboundMessage({
        message: {
          conversationId: "slack:C123:turn-activity",
          createdAtMs: 9_000,
          destination: SLACK_DESTINATION,
          inboundMessageId: "turn-activity-message",
          input: {
            authorId: "U123",
            text: "start",
          },
          receivedAtMs: 9_000,
          replyDelivery: "destination",
          delivery: "defer",
          source: "slack",
        },
        nowMs: 9_000,
      });
      await upsertTurnRecord({
        channelName: "runtime-team",
        conversationId: "slack:C123:turn-activity",
        destination: SLACK_DESTINATION,
        piMessages: [userMessage("ship it")],
        turnId: "turn-activity",
        sliceId: 1,
        source: SLACK_SOURCE,
        state: "completed",
        surface: "slack",
      });

      await expect(
        conversationStore.get({
          conversationId: "slack:C123:turn-activity",
        }),
      ).resolves.toMatchObject({
        channelName: "runtime-team",
        conversationId: "slack:C123:turn-activity",
        destination: SLACK_DESTINATION,
        lastActivityAtMs: 10_000,
        sessionSource: SLACK_SOURCE,
        source: "slack",
        visibility: "public",
      });
      await expect(
        resolveDestinationVisibility({ destination: SLACK_DESTINATION }),
      ).resolves.toBe("public");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps nested destination/source out of redis while dual-writing sql", async () => {
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const { getTurnRecord, listTurnSummaries, upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");
    const { turnCursorKey } =
      await import("@/chat/task-execution/turn-cursor-keys");
    const conversationId = "slack:C123:no-nested-routing";
    const turnId = "turn-no-nested-routing";
    const conversationStore: ConversationStore = {
      createChild: vi.fn(),
      get: vi.fn(),
      getConversationIdByProviderConversation: vi.fn(async () => undefined),
      bindProviderConversation: vi.fn(),
      getDestinationVisibility: vi.fn(async () => undefined),
      recordActivity: vi.fn(async () => undefined),
      recordExecution: vi.fn(async () => undefined),
      listByActivity: vi.fn(),
    };

    await upsertTurnRecord({
      conversationId,
      conversationStore,
      destination: SLACK_DESTINATION,
      piMessages: [userMessage("keep routing in sql")],
      turnId: turnId,
      sliceId: 1,
      source: SLACK_SOURCE,
      state: "running",
      surface: "slack",
    });

    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const stored = await stateAdapter.get(
      turnCursorKey(conversationId, turnId),
    );
    expect(stored).toEqual(
      expect.objectContaining({
        conversationId,
        turnId,
        state: "running",
      }),
    );
    expect(stored).not.toHaveProperty("destination");
    expect(stored).not.toHaveProperty("source");
    expect(stored).not.toHaveProperty("actor");

    const summaries = await listTurnSummaries(conversationId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).not.toHaveProperty("destination");
    expect(summaries[0]).not.toHaveProperty("source");
    expect(summaries[0]).not.toHaveProperty("actor");

    // Materialized reads no longer surface nested routing/identity from redis.
    const record = await getTurnRecord(conversationId, turnId);
    expect(record).toMatchObject({
      conversationId,
      turnId: turnId,
      state: "running",
    });
    expect(record).not.toHaveProperty("destination");
    expect(record).not.toHaveProperty("source");
    expect(record).not.toHaveProperty("actor");

    expect(conversationStore.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
        destination: SLACK_DESTINATION,
        sessionSource: SLACK_SOURCE,
        source: "slack",
      }),
    );
    expect(conversationStore.recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
        destination: SLACK_DESTINATION,
        source: "slack",
      }),
    );
  });

  it("requires v2 and ignores unknown fields in stored turn cursors", async () => {
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const { getTurnRecord } = await import("@/chat/task-execution/turn-cursor");
    const { turnCursorKey } =
      await import("@/chat/task-execution/turn-cursor-keys");
    const conversationId = "slack:C123:cursor-unknown-fields";
    const turnId = "turn-unknown-fields";
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await stateAdapter.set(
      turnCursorKey(conversationId, turnId),
      {
        schemaVersion: 2,
        version: 1,
        conversationId,
        turnId,
        sliceId: 1,
        state: "paused",
        startedAtMs: 1_000,
        lastProgressAtMs: 1_000,
        updatedAtMs: 1_000,
        committedSeq: -1,
        cumulativeDurationMs: 0,
        destination: SLACK_DESTINATION,
        source: SLACK_SOURCE,
        actor: {
          platform: "slack",
          teamId: "T123",
          userId: "U123",
        },
        deprecatedFlag: true,
        resumeReason: "timeout",
      },
      60_000,
    );

    const stored = await stateAdapter.get(
      turnCursorKey(conversationId, turnId),
    );
    await stateAdapter.set(
      turnCursorKey(conversationId, turnId),
      { ...(stored as Record<string, unknown>), schemaVersion: undefined },
      60_000,
    );
    await expect(getTurnRecord(conversationId, turnId)).rejects.toThrow(
      "Invalid input: expected 2",
    );
    await stateAdapter.set(
      turnCursorKey(conversationId, turnId),
      stored,
      60_000,
    );

    const record = await getTurnRecord(conversationId, turnId);
    expect(record).toMatchObject({ schemaVersion: 2, state: "paused" });
    expect(record).not.toHaveProperty("destination");
    expect(record).not.toHaveProperty("source");
    expect(record).not.toHaveProperty("actor");
    expect(record).not.toHaveProperty("deprecatedFlag");
  });

  it("fails before storing a turn-session record when SQL metadata fails", async () => {
    const { getTurnRecord, upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");

    await expect(
      upsertTurnRecord({
        conversationId: "slack:C123:metadata-failure",
        conversationStore: failingConversationStore(),
        destination: SLACK_DESTINATION,
        piMessages: [userMessage("persist anyway")],
        turnId: "turn-metadata-failure",
        sliceId: 1,
        state: "completed",
        surface: "slack",
      }),
    ).rejects.toThrow("conversation metadata unavailable");

    await expect(
      getTurnRecord("slack:C123:metadata-failure", "turn-metadata-failure"),
    ).resolves.toBeUndefined();
  });

  it("fails before storing a turn-session summary when SQL metadata fails", async () => {
    const { listTurnSummaries, recordTurnSummary } =
      await import("@/chat/task-execution/turn-cursor");

    await expect(
      recordTurnSummary({
        conversationId: "slack:C123:summary-metadata-failure",
        conversationStore: failingConversationStore(),
        destination: SLACK_DESTINATION,
        turnId: "turn-summary-metadata-failure",
        sliceId: 1,
        state: "failed",
        surface: "slack",
      }),
    ).rejects.toThrow("conversation metadata unavailable");

    await expect(
      listTurnSummaries("slack:C123:summary-metadata-failure"),
    ).resolves.toEqual([]);
  });

  it("reads the conversation recovery index only", async () => {
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const { listTurnSummaries } =
      await import("@/chat/task-execution/turn-cursor");
    const getList = vi.spyOn(getStateAdapter(), "getList");

    await expect(
      listTurnSummaries("slack:C123:bounded-summary"),
    ).resolves.toEqual([]);
    expect(getList).toHaveBeenCalledExactlyOnceWith(
      "junior:turn_cursor:v2:conversation:slack:C123:bounded-summary:index",
    );
  });

  it("ignores unknown and invalid recovery-index entries", async () => {
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const { listTurnSummaries } =
      await import("@/chat/task-execution/turn-cursor");
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const conversationId = "slack:C123:summary-unknown-fields";
    const indexKey = `junior:turn_cursor:v2:conversation:${conversationId}:index`;
    const requester = {
      platform: "slack",
      teamId: "T123",
      userId: "U123",
      userName: "alice",
    };

    await stateAdapter.appendToList(
      indexKey,
      { invalid: true },
      { ttlMs: 60_000 },
    );
    await stateAdapter.appendToList(
      indexKey,
      {
        schemaVersion: 2,
        version: 1,
        conversationId,
        cumulativeDurationMs: 0,
        lastProgressAtMs: 2,
        requester,
        turnId: "turn-summary-unknown-fields",
        sliceId: 1,
        startedAtMs: 1,
        state: "paused",
        updatedAtMs: 3,
      },
      { ttlMs: 60_000 },
    );

    const summaries = await listTurnSummaries(conversationId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      conversationId,
      turnId: "turn-summary-unknown-fields",
      state: "paused",
    });
    expect(summaries[0]).not.toHaveProperty("requester");
  });

  it("materializes auth completion events appended after the pause record", async () => {
    const { getTurnRecord, upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");
    const { recordAuthorizationCompleted } =
      await import("@/chat/conversations/projection");

    const userMessage: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "list my orgs" }],
      timestamp: 1,
    } as PiMessage;

    await upsertTurnRecord({
      conversationId: "conversation-auth-complete",
      turnId: "turn-auth-complete",
      sliceId: 1,
      state: "paused",
      piMessages: [userMessage],
      resumeReason: "auth",
      errorMessage: "plugin auth pause",
    });
    await recordAuthorizationCompleted({
      conversationId: "conversation-auth-complete",
      kind: "plugin",
      provider: "sentry",
      actorId: "U123",
      authorizationId: "auth-1",
    });

    await expect(
      getTurnRecord("conversation-auth-complete", "turn-auth-complete"),
    ).resolves.toMatchObject({
      state: "paused",
      piMessages: [
        userMessage,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: 'Authorization completed for provider "sentry". Continue the blocked request and retry the provider operation if needed.',
            },
          ],
        },
      ],
    });
  });

  it("dual-writes actor identity to SQL without storing it in redis", async () => {
    const { getTurnRecord, upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const { turnCursorKey } =
      await import("@/chat/task-execution/turn-cursor-keys");
    const { getConversationStore } = await import("@/chat/db");

    const conversationId = "slack:C123:actor-empty-commit";
    const sessionId = "turn-actor-empty-commit";
    const userMessage: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "keep going" }],
      timestamp: 1,
    } as PiMessage;
    const actor = {
      platform: "slack" as const,
      teamId: "T123",
      userId: "U123",
      userName: "alice",
      fullName: "Alice Example",
      email: "alice@sentry.io",
    };

    await upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 1,
      state: "paused",
      destination: SLACK_DESTINATION,
      source: SLACK_SOURCE,
      piMessages: [userMessage],
      actor,
      resumeReason: "timeout",
      surface: "slack",
    });

    const record = await getTurnRecord(conversationId, sessionId);
    expect(record).toMatchObject({
      piMessages: [userMessage],
      state: "paused",
    });
    expect(record).not.toHaveProperty("actor");

    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const stored = await stateAdapter.get(
      turnCursorKey(conversationId, sessionId),
    );
    expect(stored).not.toHaveProperty("actor");

    await expect(
      getConversationStore().get({ conversationId }),
    ).resolves.toMatchObject({
      actor: {
        platform: "slack",
        teamId: "T123",
        slackUserId: "U123",
        slackUserName: "alice",
        fullName: "Alice Example",
        email: "alice@sentry.io",
      },
    });
  });

  it("persists turn transcript scope and actor in the event log", async () => {
    const { getTurnRecord, listTurnSummaries, upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");
    const { loadConversationProjection } =
      await import("@/chat/conversations/projection");

    const previousQuestion: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "previous question" }],
      timestamp: 1,
    } as PiMessage;
    const currentQuestion: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "current question" }],
      timestamp: 2,
    } as PiMessage;

    await upsertTurnRecord({
      conversationId: "conversation-turn-scope",
      turnId: "turn-scope",
      sliceId: 1,
      state: "running",
      piMessages: [previousQuestion, currentQuestion],
      actor: {
        platform: "slack",
        teamId: "T123",
        userId: "U123",
        userName: "alice",
      },
      turnStartMessageIndex: 1,
    });
    await upsertTurnRecord({
      conversationId: "conversation-turn-scope",
      turnId: "turn-scope",
      sliceId: 2,
      state: "completed",
      piMessages: [previousQuestion, currentQuestion],
    });

    const scoped = await getTurnRecord("conversation-turn-scope", "turn-scope");
    expect(scoped).toMatchObject({
      turnStartMessageIndex: 1,
      piMessages: [previousQuestion, currentQuestion],
    });
    expect(scoped).not.toHaveProperty("actor");
    const projection = await loadConversationProjection({
      conversationId: "conversation-turn-scope",
    });
    expect(projection.messages).toEqual([previousQuestion, currentQuestion]);
    const instructionActor = projection.provenance
      .filter((entry) => entry.authority === "instruction" && entry.actor)
      .at(-1)?.actor;
    expect(instructionActor).toMatchObject({
      platform: "slack",
      teamId: "T123",
      userId: "U123",
      userName: "alice",
    });
    const summaries = await listTurnSummaries("conversation-turn-scope");
    expect(summaries[0]).not.toHaveProperty("turnStartMessageIndex");
  });

  it("persists and materializes per-message provenance aligned to piMessages", async () => {
    const { getTurnRecord, upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");

    const priorContext: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "prior context" }],
      timestamp: 1,
    } as PiMessage;
    const currentQuestion: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "current question" }],
      timestamp: 2,
    } as PiMessage;
    const answer = assistantMessage("answer", 3);

    await upsertTurnRecord({
      conversationId: "conversation-provenance",
      turnId: "turn-provenance",
      sliceId: 1,
      state: "completed",
      piMessages: [priorContext, currentQuestion, answer],
      actor: {
        platform: "slack",
        teamId: "T123",
        userId: "U123",
        userName: "alice",
      },
    });

    const record = await getTurnRecord(
      "conversation-provenance",
      "turn-provenance",
    );
    // The current turn's user input is an instruction attributed to its actor;
    // prior context and assistant output are unattributed context.
    expect(record?.piMessageProvenance).toEqual([
      { authority: "context" },
      {
        authority: "instruction",
        actor: {
          platform: "slack",
          teamId: "T123",
          userId: "U123",
          userName: "alice",
        },
      },
      { authority: "context" },
    ]);
    expect(record?.piMessageProvenance).toHaveLength(record!.piMessages.length);
  });

  it("derives run actors from steered message provenance while preserving the run actor", async () => {
    const { saveTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");
    const { getTurnRecord } = await import("@/chat/task-execution/turn-cursor");

    const alice = {
      platform: "slack" as const,
      teamId: "T123",
      userId: "U_ALICE",
      userName: "alice",
    };
    const bob = {
      platform: "slack" as const,
      teamId: "T123",
      userId: "U_BOB",
      userName: "bob",
    };
    const aliceMessage: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "start the deploy" }],
      timestamp: 1,
    } as PiMessage;
    const bobMessage: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "actually wait, run the tests first" }],
      timestamp: 2,
    } as PiMessage;

    await saveTurnCheckpoint({
      mode: "running",
      conversationId: "conversation-multi-actor",
      turnId: "turn-multi-actor",
      sliceId: 1,
      messages: [aliceMessage],
      actor: alice,
    });
    // A second human steers the same run; their message commits as an
    // instruction attributed to bob, while Alice remains the bound run actor.
    await saveTurnCheckpoint({
      mode: "running",
      conversationId: "conversation-multi-actor",
      turnId: "turn-multi-actor",
      sliceId: 2,
      messages: [aliceMessage, bobMessage],
      actor: alice,
      trailingMessageProvenance: [{ authority: "instruction", actor: bob }],
    });

    // getTurnRecord re-materializes from the stored record and the
    // committed provenance, so this is also the continuation/materialization
    // path — it must reproduce the same first-seen-ordered set.
    const record = await getTurnRecord(
      "conversation-multi-actor",
      "turn-multi-actor",
    );
    expect(record).not.toHaveProperty("actor");
    expect(record?.piMessageProvenance).toEqual([
      { authority: "instruction", actor: alice },
      { authority: "instruction", actor: bob },
    ]);
    expect(record?.actors).toEqual([alice, bob]);
  });

  it("has an empty run-actors set for a system-actor run with no human instructions", async () => {
    const { getTurnRecord, upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");

    await upsertTurnRecord({
      conversationId: "conversation-system-actor",
      turnId: "turn-system-actor",
      sliceId: 1,
      state: "completed",
      // No actor: nothing is attributed as an instruction actor.
      piMessages: [userMessage("system dispatch input")],
    });

    const record = await getTurnRecord(
      "conversation-system-actor",
      "turn-system-actor",
    );
    expect(record?.actors).toEqual([]);
  });

  it("carries cumulative diagnostics across pause records", async () => {
    const { saveTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");
    const { getTurnRecord, upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");

    await upsertTurnRecord({
      conversationId: "conversation-1",
      turnId: "turn-1",
      sliceId: 1,
      state: "paused",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "continue me" }],
          timestamp: 1,
        },
      ],
      resumeReason: "timeout",
      cumulativeDurationMs: 1_500,
      cumulativeUsage: {
        inputTokens: 10,
        outputTokens: 3,
        reasoningTokens: 1,
        cost: { input: 0.001, output: 0.002, total: 0.003 },
      },
    });

    await saveTurnCheckpoint({
      mode: "paused",
      reason: "timeout",
      conversationId: "conversation-1",
      turnId: "turn-1",
      sliceId: 1,
      durationMs: 2_250,
      usage: {
        outputTokens: 7,
        cachedInputTokens: 2,
        reasoningTokens: 4,
        cost: {
          input: 0.004,
          output: 0.005,
          cacheRead: 0.0001,
          total: 0.0091,
        },
      },
      messages: [],
      errorMessage: "timed out again",
    });

    const sessionRecord = await getTurnRecord("conversation-1", "turn-1");
    expect(sessionRecord).toMatchObject({
      cumulativeDurationMs: 3_750,
      cumulativeUsage: {
        inputTokens: 10,
        outputTokens: 10,
        cachedInputTokens: 2,
        reasoningTokens: 5,
        cost: {
          input: 0.005,
          output: 0.007,
          cacheRead: 0.0001,
          total: 0.0121,
        },
      },
    });
  });

  it("fails timeout sessions instead of scheduling beyond the execution limit", async () => {
    const { saveTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");
    const { botConfig } = await import("@/chat/config");
    const { getTurnRecord, upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");

    const piMessages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "keep trying" }],
        timestamp: 1,
      },
    ];

    await upsertTurnRecord({
      conversationId: "conversation-timeout-cap",
      turnId: "turn-timeout-cap",
      sliceId: botConfig.maxSlicesPerTurn,
      state: "paused",
      piMessages,
      resumeReason: "timeout",
      cumulativeDurationMs: 12_000,
    });

    await expect(
      saveTurnCheckpoint({
        mode: "paused",
        reason: "timeout",
        conversationId: "conversation-timeout-cap",
        turnId: "turn-timeout-cap",
        sliceId: botConfig.maxSlicesPerTurn,
        durationMs: 3_000,
        messages: piMessages,
        errorMessage: "timed out again",
      }),
    ).rejects.toThrow(/execution limit/);

    await expect(
      getTurnRecord("conversation-timeout-cap", "turn-timeout-cap"),
    ).resolves.toMatchObject({
      state: "failed",
      sliceId: botConfig.maxSlicesPerTurn,
      cumulativeDurationMs: 15_000,
      errorMessage: expect.stringContaining("execution limit"),
      piMessages,
    });
  });

  it("falls back to the last stored safe boundary when auth pause captures a non-continuable tail", async () => {
    const { saveTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");
    const { getTurnRecord, upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");

    const safeBoundary: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "connect and answer" }],
        timestamp: 1,
      },
    ];

    await upsertTurnRecord({
      conversationId: "conversation-auth-tail",
      turnId: "turn-auth-tail",
      sliceId: 1,
      state: "running",
      piMessages: safeBoundary,
    });

    const authSessionRecord = await saveTurnCheckpoint({
      mode: "paused",
      reason: "auth",
      conversationId: "conversation-auth-tail",
      turnId: "turn-auth-tail",
      sliceId: 1,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "calling credential-gated tool" }],
          api: "responses",
          provider: "openai",
          model: "gpt-5.3",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          timestamp: 2,
          stopReason: "toolUse",
        },
      ],
      errorMessage: "plugin auth pause",
    });

    expect(authSessionRecord).toMatchObject({
      state: "paused",
      sliceId: 2,
      resumeReason: "auth",
      piMessages: safeBoundary,
    });

    await expect(
      getTurnRecord("conversation-auth-tail", "turn-auth-tail"),
    ).resolves.toMatchObject({
      state: "paused",
      piMessages: safeBoundary,
    });
  });

  it("creates auth-pause records before a prompt checkpoint", async () => {
    const { loadTurnCheckpoint, saveTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");
    const { getTurnRecord } = await import("@/chat/task-execution/turn-cursor");

    const authRecord = await saveTurnCheckpoint({
      mode: "paused",
      reason: "auth",
      conversationId: "conversation-auth-empty",
      turnId: "turn-auth-empty",
      sliceId: 1,
      messages: [],
      errorMessage: "auth pause",
    });

    expect(authRecord).toMatchObject({
      conversationId: "conversation-auth-empty",
      turnId: "turn-auth-empty",
      state: "paused",
      piMessages: [],
      resumeReason: "auth",
    });
    await expect(
      loadTurnCheckpoint({
        conversationId: "conversation-auth-empty",
        turnId: "turn-auth-empty",
      }),
    ).resolves.toMatchObject({
      resumed: true,
      sliceId: 2,
    });

    await expect(
      saveTurnCheckpoint({
        mode: "paused",
        reason: "timeout",
        conversationId: "conversation-timeout-empty",
        turnId: "turn-timeout-empty",
        sliceId: 1,
        messages: [],
        errorMessage: "timeout",
      }),
    ).resolves.toBeUndefined();

    await expect(
      getTurnRecord("conversation-timeout-empty", "turn-timeout-empty"),
    ).resolves.toBeUndefined();
  });

  it("retries and surfaces completed session persistence failures", async () => {
    const getTurnRecord = vi.fn(async () => {
      throw new Error("state adapter unavailable");
    });
    vi.doMock("@/chat/task-execution/turn-cursor", () => ({
      getTurnRecord,
      upsertTurnRecord: vi.fn(),
    }));
    const { saveTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");

    await expect(
      saveTurnCheckpoint({
        mode: "completed",
        conversationId: "conversation-1",
        turnId: "turn-1",
        sliceId: 1,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "help me" }],
            timestamp: 1,
          },
        ],
      }),
    ).rejects.toThrow("state adapter unavailable");
    expect(getTurnRecord).toHaveBeenCalledTimes(3);
  });

  it("retries the same completed totals without double-counting", async () => {
    const getTurnRecord = vi.fn(async () => ({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 2,
      state: "paused",
      piMessages: [],
      piMessageProvenance: [],
      cumulativeDurationMs: 1_000,
      cumulativeUsage: { inputTokens: 10 },
    }));
    const upsertTurnRecord = vi
      .fn()
      .mockRejectedValueOnce(new Error("summary append failed"))
      .mockRejectedValueOnce(new Error("summary append failed"))
      .mockResolvedValue(undefined);
    vi.doMock("@/chat/task-execution/turn-cursor", () => ({
      getTurnRecord,
      upsertTurnRecord,
    }));
    const { saveTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");

    await saveTurnCheckpoint({
      mode: "completed",
      conversationId: "conversation-1",
      turnId: "turn-1",
      durationMs: 500,
      usage: { inputTokens: 5 },
      messages: [userMessage("done")],
    });

    expect(getTurnRecord).toHaveBeenCalledTimes(1);
    expect(upsertTurnRecord).toHaveBeenCalledTimes(3);
    for (const [target] of upsertTurnRecord.mock.calls) {
      expect(target).toMatchObject({
        cumulativeDurationMs: 1_500,
        cumulativeUsage: { inputTokens: 15 },
      });
    }
  });

  it("keeps runtime bootstrap out of durable completed history", async () => {
    const { saveTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");
    const { getTurnRecord } = await import("@/chat/task-execution/turn-cursor");

    await saveTurnCheckpoint({
      mode: "completed",
      conversationId: "conversation-completed",
      turnId: "turn-completed",
      sliceId: 1,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<runtime-turn-context>\nstale\n</runtime-turn-context>",
            },
            { type: "text", text: "actual request" },
          ],
          timestamp: 1,
        } as PiMessage,
        assistantMessage("done", 2),
      ],
    });

    await expect(
      getTurnRecord("conversation-completed", "turn-completed"),
    ).resolves.toMatchObject({
      state: "completed",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "actual request" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      ],
    });
  });

  it("commits dispatch outcome and delivery receipt with terminal state", async () => {
    const { saveTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");
    const { getTurnRecord } = await import("@/chat/task-execution/turn-cursor");

    await saveTurnCheckpoint({
      mode: "completed",
      conversationId: "agent-dispatch:dispatch_atomic",
      turnId: "dispatch:dispatch_atomic",
      sliceId: 4,
      messages: [userMessage("done")],
      destination: SLACK_DESTINATION,
      dispatchId: "dispatch_atomic",
      dispatchOutcome: "failed",
      resultMessageId: "1700000000.002",
      source: SLACK_SOURCE,
      surface: "api",
    });

    await expect(
      getTurnRecord(
        "agent-dispatch:dispatch_atomic",
        "dispatch:dispatch_atomic",
      ),
    ).resolves.toMatchObject({
      dispatchId: "dispatch_atomic",
      dispatchOutcome: "failed",
      resultMessageId: "1700000000.002",
      sliceId: 4,
      state: "completed",
    });
  });

  it("stores running records only at continuable message boundaries", async () => {
    const { saveTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");
    const { getTurnRecord } = await import("@/chat/task-execution/turn-cursor");
    const userBoundary: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "help me" }],
        timestamp: 1,
      },
    ];
    const unsafeAssistantBoundary: PiMessage[] = [
      ...userBoundary,
      assistantMessage("working", 2),
    ];
    const toolResultBoundary: PiMessage[] = [
      ...unsafeAssistantBoundary,
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 3,
      } as PiMessage,
    ];

    await expect(
      saveTurnCheckpoint({
        mode: "running",
        conversationId: "conversation-1",
        turnId: "turn-1",
        sliceId: 1,
        messages: userBoundary,
      }),
    ).resolves.toBeTruthy();

    await expect(
      saveTurnCheckpoint({
        mode: "running",
        conversationId: "conversation-1",
        turnId: "turn-1",
        sliceId: 1,
        messages: unsafeAssistantBoundary,
      }),
    ).resolves.toBeUndefined();

    let sessionRecord = await getTurnRecord("conversation-1", "turn-1");
    expect(sessionRecord).toMatchObject({
      state: "running",
      piMessages: userBoundary,
    });

    await expect(
      saveTurnCheckpoint({
        mode: "running",
        conversationId: "conversation-1",
        turnId: "turn-1",
        sliceId: 1,
        messages: toolResultBoundary,
      }),
    ).resolves.toBeTruthy();

    sessionRecord = await getTurnRecord("conversation-1", "turn-1");
    expect(sessionRecord).toMatchObject({
      state: "running",
      piMessages: toolResultBoundary,
    });
  });

  it("reports running record storage failures", async () => {
    vi.doMock("@/chat/task-execution/turn-cursor", async (importOriginal) => {
      const actual =
        await importOriginal<
          typeof import("@/chat/task-execution/turn-cursor")
        >();
      return {
        ...actual,
        upsertTurnRecord: vi.fn(async () => {
          throw new Error("storage unavailable");
        }),
      };
    });
    const { saveTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");

    await expect(
      saveTurnCheckpoint({
        mode: "running",
        conversationId: "conversation-storage-failure",
        turnId: "turn-storage-failure",
        sliceId: 1,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "help me" }],
            timestamp: 1,
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects true history branches without reporting a running-session exception", async () => {
    const logException = vi.fn();
    vi.doMock("@/chat/logging", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/chat/logging")>();
      return { ...actual, logException };
    });
    const { saveTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");
    const committedUser = userMessage("committed");
    const staleUser = userMessage("stale");

    await expect(
      saveTurnCheckpoint({
        mode: "running",
        conversationId: "conversation-stale-checkpoint",
        turnId: "turn-stale-checkpoint",
        sliceId: 1,
        messages: [committedUser],
      }),
    ).resolves.toBeTruthy();
    await expect(
      saveTurnCheckpoint({
        mode: "running",
        conversationId: "conversation-stale-checkpoint",
        turnId: "turn-stale-checkpoint",
        sliceId: 1,
        messages: [staleUser],
      }),
    ).resolves.toBeUndefined();

    expect(logException).not.toHaveBeenCalled();
  });

  it("appends after in-place assistant envelope mutations on committed messages", async () => {
    const { saveTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");
    const { getTurnRecord } = await import("@/chat/task-execution/turn-cursor");
    const user = userMessage("help me");
    user.timestamp = 1;
    const assistantWithTools = {
      ...assistantMessage("working", 2),
      content: [
        { type: "text", text: "working" },
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "echo ok" },
        },
      ],
      stopReason: "toolUse",
    } as PiMessage;
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 3,
    } as PiMessage;
    const nextUser = userMessage("thanks");
    nextUser.timestamp = 4;

    await expect(
      saveTurnCheckpoint({
        mode: "running",
        conversationId: "conversation-mutated-prefix",
        turnId: "turn-mutated-prefix",
        sliceId: 1,
        messages: [user, assistantWithTools, toolResult],
      }),
    ).resolves.toBeTruthy();

    const mutatedAssistant = {
      ...assistantWithTools,
      usage: {
        ...(assistantWithTools as { usage?: Record<string, number> }).usage,
        output: 42,
        totalTokens: 42,
      },
    } as PiMessage;

    await expect(
      saveTurnCheckpoint({
        mode: "running",
        conversationId: "conversation-mutated-prefix",
        turnId: "turn-mutated-prefix",
        sliceId: 1,
        messages: [user, mutatedAssistant, toolResult, nextUser],
      }),
    ).resolves.toBeTruthy();

    // Append-only: durable identity lets the suffix commit, but the already
    // committed assistant envelope is not rewritten when Pi mutates usage.
    await expect(
      getTurnRecord("conversation-mutated-prefix", "turn-mutated-prefix"),
    ).resolves.toMatchObject({
      state: "running",
      piMessages: [user, assistantWithTools, toolResult, nextUser],
    });
  });

  it("promotes the latest running record when timeout capture has no messages", async () => {
    const { saveTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");
    const { getTurnRecord } = await import("@/chat/task-execution/turn-cursor");
    const messages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "help me" }],
        timestamp: 1,
      },
    ];

    await saveTurnCheckpoint({
      mode: "running",
      conversationId: "conversation-1",
      turnId: "turn-1",
      sliceId: 1,
      messages,
    });

    await saveTurnCheckpoint({
      mode: "paused",
      reason: "timeout",
      conversationId: "conversation-1",
      turnId: "turn-1",
      sliceId: 1,
      messages: [],
      errorMessage: "provider stream interrupted",
    });

    const sessionRecord = await getTurnRecord("conversation-1", "turn-1");
    expect(sessionRecord).toMatchObject({
      state: "paused",
      resumeReason: "timeout",
      sliceId: 2,
      piMessages: messages,
    });
  });

  it("rejects an implicit branch from committed agent history", async () => {
    const { upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");
    const user: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "help me" }],
      timestamp: 1,
    };
    const unsafeAssistant = assistantMessage("not committed", 2);
    await upsertTurnRecord({
      conversationId: "conversation-branch",
      turnId: "turn-branch",
      sliceId: 1,
      state: "running",
      piMessages: [user, unsafeAssistant],
    });
    await expect(
      upsertTurnRecord({
        conversationId: "conversation-branch",
        turnId: "turn-branch",
        sliceId: 2,
        state: "paused",
        piMessages: [user],
        resumeReason: "timeout",
      }),
    ).rejects.toThrow("changed before its committed boundary");
  });

  it("keeps older turn records pinned to their committed projection after reset", async () => {
    const { failTurnRecord, getTurnRecord, upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");
    const { loadProjection } = await import("@/chat/conversations/projection");
    const { getConversationEventStore } = await import("@/chat/db");
    const oldRequest: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "old request" }],
      timestamp: 1,
    };
    const newRequest: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "new request" }],
      timestamp: 2,
    };
    const newFollowup = assistantMessage("new followup", 3);

    const oldRecord = await upsertTurnRecord({
      conversationId: "conversation-projection-pin",
      turnId: "turn-old",
      sliceId: 1,
      state: "paused",
      resumeReason: "timeout",
      piMessages: [oldRequest],
    });
    await getConversationEventStore().replaceHistory(
      "conversation-projection-pin",
      {
        createdAtMs: 2,
        data: {
          type: "compaction",
          modelProfile: "standard",
          modelId: "test/model",
          replacementHistory: [
            {
              item: historyItemFromPiMessage(newRequest, {
                authority: "context",
              }),
            },
          ],
        },
      },
    );
    await upsertTurnRecord({
      conversationId: "conversation-projection-pin",
      turnId: "turn-new",
      sliceId: 1,
      state: "completed",
      piMessages: [newRequest, newFollowup],
    });

    await expect(
      getTurnRecord("conversation-projection-pin", "turn-old"),
    ).resolves.toMatchObject({
      piMessages: [oldRequest],
    });

    await failTurnRecord({
      conversationId: "conversation-projection-pin",
      turnId: "turn-old",
      expectedVersion: oldRecord.version,
      errorMessage: "stale timeout callback",
    });

    await expect(
      loadProjection({
        conversationId: "conversation-projection-pin",
      }),
    ).resolves.toEqual([newRequest, newFollowup]);
  });

  it("resumes an unfinished turn from a committed handoff replacement", async () => {
    const { loadTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");
    const { upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");
    const { getConversationEventStore } = await import("@/chat/db");
    const conversationId = "conversation-handoff-resume";
    const turnId = "turn-handoff-resume";
    const staleRuntimeContext =
      "<runtime-turn-context>stale runtime context</runtime-turn-context>";
    const oldRequest: PiMessage = {
      role: "user",
      content: [
        { type: "text", text: staleRuntimeContext },
        { type: "text", text: "old request" },
      ],
      timestamp: 1,
    };
    const handoffSummary: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "continue from the handoff summary" }],
      timestamp: 2,
    };

    await upsertTurnRecord({
      conversationId,
      turnId: turnId,
      sliceId: 1,
      state: "paused",
      resumeReason: "yield",
      piMessages: [oldRequest],
    });
    await getConversationEventStore().replaceHistory(conversationId, {
      createdAtMs: 2,
      data: {
        type: "handoff",
        modelProfile: "handoff",
        modelId: "openai/gpt-5.6-sol",
        triggeringToolCallId: "handoff-call",
        replacementHistory: [
          {
            item: historyItemFromPiMessage(handoffSummary, {
              authority: "context",
            }),
          },
        ],
      },
    });

    await expect(
      loadTurnCheckpoint({ conversationId, turnId }),
    ).resolves.toMatchObject({
      resumed: true,
      record: {
        piMessages: [handoffSummary],
        turnStartMessageIndex: 0,
      },
    });
  });

  it("restores unmatched runtime context before an active-turn replacement", async () => {
    const { loadTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");
    const { upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");
    const runtimeContext: PiMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: "<runtime-turn-context>trusted runtime context</runtime-turn-context>",
        },
      ],
      timestamp: 1,
    };
    const instruction: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "finish the current request" }],
      timestamp: 2,
    };
    const summary: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "active-turn summary" }],
      timestamp: 3,
    };

    await upsertTurnRecord({
      conversationId: "conversation-active-compaction-resume",
      turnId: "turn-active-compaction-resume",
      sliceId: 1,
      state: "paused",
      resumeReason: "yield",
      piMessages: [runtimeContext, instruction, summary],
    });

    const resumed = await loadTurnCheckpoint({
      conversationId: "conversation-active-compaction-resume",
      turnId: "turn-active-compaction-resume",
    });

    expect(resumed.resumed).toBe(true);
    expect(resumed.record?.piMessages).toEqual([
      runtimeContext,
      instruction,
      summary,
    ]);
  });

  it("restores mid-run AGENTS context at its causal position", async () => {
    const { loadTurnCheckpoint } =
      await import("@/chat/task-execution/checkpoint");
    const { upsertTurnRecord } =
      await import("@/chat/task-execution/turn-cursor");
    const instruction: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "start the request" }],
      timestamp: 1,
    };
    const agents = buildAgentsInstructionsMessage({
      directory: "/vercel/sandbox/repo",
      text: "Use the repository formatter.",
      timestamp: 3,
    });
    const assistant = assistantMessage("continued after instructions", 4);

    await upsertTurnRecord({
      conversationId: "conversation-agents-order-resume",
      turnId: "turn-agents-order-resume",
      sliceId: 1,
      state: "paused",
      resumeReason: "yield",
      piMessages: [instruction, agents, assistant],
    });

    const resumed = await loadTurnCheckpoint({
      conversationId: "conversation-agents-order-resume",
      turnId: "turn-agents-order-resume",
    });

    expect(resumed.record?.piMessages).toEqual([
      instruction,
      agents,
      assistant,
    ]);
  });
});
