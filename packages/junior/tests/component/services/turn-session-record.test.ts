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

describe("persistAuthPauseSessionRecord", () => {
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
    vi.doUnmock("@/chat/state/turn-session");
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("keeps unfinished turn sessions for one day and terminal sessions for one hour", async () => {
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const stateAdapter = getStateAdapter();
    const set = vi.spyOn(stateAdapter, "set");
    const appendToList = vi.spyOn(stateAdapter, "appendToList");

    const runtimeContext = buildAgentsInstructionsMessage({
      text: "repo instructions",
    });
    await upsertAgentTurnSessionRecord({
      conversationId: "local:ttl-split:turn",
      piMessages: [runtimeContext],
      sessionId: "turn-ttl-split",
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
      "junior:agent_turn_session:conversation:local:ttl-split:turn:index",
    );
    // Recovery index stays on the resume window so terminal writes cannot
    // expire unfinished sibling summaries.
    expect(appendToList.mock.calls[0]?.[2]?.ttlMs).toBe(24 * 60 * 60 * 1000);

    set.mockClear();
    appendToList.mockClear();
    await upsertAgentTurnSessionRecord({
      conversationId: "local:ttl-split:turn",
      piMessages: [runtimeContext],
      sessionId: "turn-ttl-split",
      sliceId: 1,
      state: "completed",
    });
    expect(set.mock.calls.at(-1)?.[1]).not.toHaveProperty("runtimeContext");
    expect(set.mock.calls.at(-1)?.[2]).toBe(60 * 60 * 1000);
    expect(appendToList).toHaveBeenCalledTimes(1);
    expect(appendToList.mock.calls[0]?.[2]?.ttlMs).toBe(24 * 60 * 60 * 1000);
  });

  it("keeps dispatch correlation write-once across session summaries", async () => {
    const { recordAgentTurnSessionSummary } =
      await import("@/chat/state/turn-session");
    await recordAgentTurnSessionSummary({
      conversationId: "agent-dispatch:dispatch_one",
      dispatchId: "dispatch_one",
      sessionId: "dispatch:dispatch_one",
      sliceId: 1,
      state: "running",
    });

    await expect(
      recordAgentTurnSessionSummary({
        conversationId: "agent-dispatch:dispatch_one",
        dispatchId: "dispatch_other",
        sessionId: "dispatch:dispatch_one",
        sliceId: 1,
        state: "completed",
      }),
    ).rejects.toThrow("dispatchId cannot be changed");
  });

  it("reuses the latest stored transcript when the auth pause captured no messages", async () => {
    const { persistAuthPauseSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    const priorMessages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "help me" }],
        timestamp: 1,
      },
    ];

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 1,
      state: "awaiting_resume",
      source: SLACK_SOURCE,
      piMessages: priorMessages,
      resumeReason: "auth",
      errorMessage: "initial auth pause",
    });

    const authSessionRecord = await persistAuthPauseSessionRecord({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      currentSliceId: 1,
      messages: [],
      errorMessage: "plugin auth pause",
    });

    expect(authSessionRecord?.sliceId).toBe(2);

    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-1",
      "turn-1",
    );
    expect(sessionRecord).toMatchObject({
      state: "awaiting_resume",
      sliceId: 2,
      resumedFromSliceId: 1,
      resumeReason: "auth",
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
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { getConversationStore } = await import("@/chat/db");
    const stateAdapter = getStateAdapter();
    const set = vi.spyOn(stateAdapter, "set");
    const actor = {
      platform: "slack",
      teamId: "T123",
      userId: "U123",
    } as const;
    const usage = { inputTokens: 7, outputTokens: 3 };

    await upsertAgentTurnSessionRecord({
      actor,
      channelName: "runtime-team",
      conversationId: "slack:C123:ops-bag",
      cumulativeDurationMs: 1_500,
      cumulativeUsage: usage,
      destination: SLACK_DESTINATION,
      piMessages: [userMessage("ship it")],
      sessionId: "turn-ops-bag",
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
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const conversationStore = getConversationStore();
    const conversationId = "local:metrics-work-lease";
    const sessionId = "turn-metrics-work-lease";

    await upsertAgentTurnSessionRecord({
      conversationId,
      cumulativeDurationMs: 1_500,
      cumulativeUsage: { inputTokens: 7 },
      piMessages: [userMessage("metered turn")],
      sessionId,
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

    const recovered = await getAgentTurnSessionRecord(
      conversationId,
      sessionId,
    );
    expect(recovered).toMatchObject({
      cumulativeDurationMs: 1_500,
      cumulativeUsage: { inputTokens: 7 },
    });
    await upsertAgentTurnSessionRecord({
      conversationId,
      piMessages: recovered!.piMessages,
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
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
    const { recordAgentTurnSessionSummary, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const conversationStore = getConversationStore();
    const conversationId = "local:metrics-session-scope";

    await recordAgentTurnSessionSummary({
      conversationId,
      cumulativeDurationMs: 1_500,
      cumulativeUsage: { inputTokens: 7 },
      sessionId: "turn-first",
      sliceId: 1,
      state: "completed",
    });
    await upsertAgentTurnSessionRecord({
      conversationId,
      piMessages: [userMessage("second")],
      sessionId: "turn-second",
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
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
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
          delivery: "defer",
          source: "slack",
        },
        nowMs: 9_000,
      });
      await upsertAgentTurnSessionRecord({
        channelName: "runtime-team",
        conversationId: "slack:C123:turn-activity",
        destination: SLACK_DESTINATION,
        piMessages: [userMessage("ship it")],
        sessionId: "turn-activity",
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
    const {
      getAgentTurnSessionRecord,
      listAgentTurnSessionSummariesForConversation,
      upsertAgentTurnSessionRecord,
    } = await import("@/chat/state/turn-session");
    const { agentTurnSessionKey } =
      await import("@/chat/state/turn-session-keys");
    const conversationId = "slack:C123:no-nested-routing";
    const sessionId = "turn-no-nested-routing";
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

    await upsertAgentTurnSessionRecord({
      conversationId,
      conversationStore,
      destination: SLACK_DESTINATION,
      piMessages: [userMessage("keep routing in sql")],
      sessionId,
      sliceId: 1,
      source: SLACK_SOURCE,
      state: "running",
      surface: "slack",
    });

    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const stored = await stateAdapter.get(
      agentTurnSessionKey(conversationId, sessionId),
    );
    expect(stored).toEqual(
      expect.objectContaining({
        conversationId,
        sessionId,
        state: "running",
      }),
    );
    expect(stored).not.toHaveProperty("destination");
    expect(stored).not.toHaveProperty("source");
    expect(stored).not.toHaveProperty("actor");

    const summaries =
      await listAgentTurnSessionSummariesForConversation(conversationId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).not.toHaveProperty("destination");
    expect(summaries[0]).not.toHaveProperty("source");
    expect(summaries[0]).not.toHaveProperty("actor");

    // Materialized reads no longer surface nested routing/identity from redis.
    const record = await getAgentTurnSessionRecord(conversationId, sessionId);
    expect(record).toMatchObject({
      conversationId,
      sessionId,
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

  it("strips deprecated fields from legacy redis records", async () => {
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const { getAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { agentTurnSessionKey } =
      await import("@/chat/state/turn-session-keys");
    const conversationId = "slack:C123:legacy-nested-routing";
    const sessionId = "turn-legacy-nested-routing";
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await stateAdapter.set(
      agentTurnSessionKey(conversationId, sessionId),
      {
        version: 1,
        conversationId,
        sessionId,
        sliceId: 1,
        state: "awaiting_resume",
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

    const record = await getAgentTurnSessionRecord(conversationId, sessionId);
    expect(record).toMatchObject({ state: "awaiting_resume" });
    expect(record).not.toHaveProperty("destination");
    expect(record).not.toHaveProperty("source");
    expect(record).not.toHaveProperty("actor");
    expect(record).not.toHaveProperty("deprecatedFlag");
  });

  it("fails before storing a turn-session record when SQL metadata fails", async () => {
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    await expect(
      upsertAgentTurnSessionRecord({
        conversationId: "slack:C123:metadata-failure",
        conversationStore: failingConversationStore(),
        destination: SLACK_DESTINATION,
        piMessages: [userMessage("persist anyway")],
        sessionId: "turn-metadata-failure",
        sliceId: 1,
        state: "completed",
        surface: "slack",
      }),
    ).rejects.toThrow("conversation metadata unavailable");

    await expect(
      getAgentTurnSessionRecord(
        "slack:C123:metadata-failure",
        "turn-metadata-failure",
      ),
    ).resolves.toBeUndefined();
  });

  it("fails before storing a turn-session summary when SQL metadata fails", async () => {
    const {
      listAgentTurnSessionSummariesForConversation,
      recordAgentTurnSessionSummary,
    } = await import("@/chat/state/turn-session");

    await expect(
      recordAgentTurnSessionSummary({
        conversationId: "slack:C123:summary-metadata-failure",
        conversationStore: failingConversationStore(),
        destination: SLACK_DESTINATION,
        sessionId: "turn-summary-metadata-failure",
        sliceId: 1,
        state: "failed",
        surface: "slack",
      }),
    ).rejects.toThrow("conversation metadata unavailable");

    await expect(
      listAgentTurnSessionSummariesForConversation(
        "slack:C123:summary-metadata-failure",
      ),
    ).resolves.toEqual([]);
  });

  it("reads the conversation recovery index only", async () => {
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const { listAgentTurnSessionSummariesForConversation } =
      await import("@/chat/state/turn-session");
    const getList = vi.spyOn(getStateAdapter(), "getList");

    await expect(
      listAgentTurnSessionSummariesForConversation(
        "slack:C123:bounded-summary",
      ),
    ).resolves.toEqual([]);
    expect(getList).toHaveBeenCalledExactlyOnceWith(
      "junior:agent_turn_session:conversation:slack:C123:bounded-summary:index",
    );
  });

  it("strips unknown fields from legacy summaries", async () => {
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const { listAgentTurnSessionSummariesForConversation } =
      await import("@/chat/state/turn-session");
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const conversationId = "slack:C123:legacy-summary";
    const indexKey = `junior:agent_turn_session:conversation:${conversationId}:index`;
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
        version: 1,
        conversationId,
        cumulativeDurationMs: 0,
        lastProgressAtMs: 2,
        requester,
        sessionId: "turn-legacy-summary",
        sliceId: 1,
        startedAtMs: 1,
        state: "awaiting_resume",
        updatedAtMs: 3,
      },
      { ttlMs: 60_000 },
    );

    const summaries =
      await listAgentTurnSessionSummariesForConversation(conversationId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      conversationId,
      sessionId: "turn-legacy-summary",
      state: "awaiting_resume",
    });
    expect(summaries[0]).not.toHaveProperty("requester");
  });

  it("collapses recovery summaries by version, then lifecycle rank", async () => {
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const { listAgentTurnSessionSummariesForConversation } =
      await import("@/chat/state/turn-session");
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();

    async function seedAndRead(
      conversationId: string,
      sessionId: string,
      entries: Array<Record<string, unknown>>,
    ) {
      const indexKey = `junior:agent_turn_session:conversation:${conversationId}:index`;
      for (const [index, entry] of entries.entries()) {
        await stateAdapter.appendToList(
          indexKey,
          {
            conversationId,
            sessionId,
            sliceId: 1,
            surface: "api",
            updatedAtMs: (index + 1) * 10,
            ...entry,
          },
          { ttlMs: 60_000 },
        );
      }
      return listAgentTurnSessionSummariesForConversation(conversationId);
    }

    // Same-version lagging start write loses to a durable pause/terminal.
    await expect(
      seedAndRead("slack:C123:terminal-index-race", "turn-terminal-index-race", [
        {
          version: 1,
          dispatchId: "dispatch_index_race",
          dispatchOutcome: "blocked",
          resultMessageId: "1700000000.000200",
          state: "failed",
        },
        {
          version: 0,
          state: "running",
        },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        dispatchOutcome: "blocked",
        resultMessageId: "1700000000.000200",
        sessionId: "turn-terminal-index-race",
        state: "failed",
        version: 1,
      }),
    ]);

    await expect(
      seedAndRead("slack:C123:awaiting-index-race", "turn-awaiting-index-race", [
        {
          version: 1,
          resumeReason: "timeout",
          state: "awaiting_resume",
        },
        {
          version: 0,
          state: "running",
        },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        resumeReason: "timeout",
        sessionId: "turn-awaiting-index-race",
        state: "awaiting_resume",
        version: 1,
      }),
    ]);

    // A live post-resume running upsert advances version and must win over the
    // stale pause summary, or stranded mid-resume recovery never runs.
    await expect(
      seedAndRead("slack:C123:resume-running-race", "turn-resume-running-race", [
        {
          version: 1,
          resumeReason: "timeout",
          state: "awaiting_resume",
        },
        {
          version: 2,
          state: "running",
        },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        sessionId: "turn-resume-running-race",
        state: "running",
        version: 2,
      }),
    ]);
  });

  it("materializes auth completion events appended after the pause record", async () => {
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { recordAuthorizationCompleted } =
      await import("@/chat/conversations/projection");

    const userMessage: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "list my orgs" }],
      timestamp: 1,
    } as PiMessage;

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-auth-complete",
      sessionId: "turn-auth-complete",
      sliceId: 1,
      state: "awaiting_resume",
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
      getAgentTurnSessionRecord(
        "conversation-auth-complete",
        "turn-auth-complete",
      ),
    ).resolves.toMatchObject({
      state: "awaiting_resume",
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
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const { agentTurnSessionKey } =
      await import("@/chat/state/turn-session-keys");
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

    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 1,
      state: "awaiting_resume",
      destination: SLACK_DESTINATION,
      source: SLACK_SOURCE,
      piMessages: [userMessage],
      actor,
      resumeReason: "timeout",
      surface: "slack",
    });

    const record = await getAgentTurnSessionRecord(conversationId, sessionId);
    expect(record).toMatchObject({
      piMessages: [userMessage],
      state: "awaiting_resume",
    });
    expect(record).not.toHaveProperty("actor");

    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const stored = await stateAdapter.get(
      agentTurnSessionKey(conversationId, sessionId),
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
    const {
      getAgentTurnSessionRecord,
      listAgentTurnSessionSummariesForConversation,
      upsertAgentTurnSessionRecord,
    } = await import("@/chat/state/turn-session");
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

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-turn-scope",
      sessionId: "turn-scope",
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
    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-turn-scope",
      sessionId: "turn-scope",
      sliceId: 2,
      state: "completed",
      piMessages: [previousQuestion, currentQuestion],
    });

    const scoped = await getAgentTurnSessionRecord(
      "conversation-turn-scope",
      "turn-scope",
    );
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
    const summaries = await listAgentTurnSessionSummariesForConversation(
      "conversation-turn-scope",
    );
    expect(summaries[0]).not.toHaveProperty("turnStartMessageIndex");
  });

  it("persists and materializes per-message provenance aligned to piMessages", async () => {
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

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

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-provenance",
      sessionId: "turn-provenance",
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

    const record = await getAgentTurnSessionRecord(
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
    const { persistRunningSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

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

    await persistRunningSessionRecord({
      conversationId: "conversation-multi-actor",
      sessionId: "turn-multi-actor",
      sliceId: 1,
      messages: [aliceMessage],
      actor: alice,
    });
    // A second human steers the same run; their message commits as an
    // instruction attributed to bob, while Alice remains the bound run actor.
    await persistRunningSessionRecord({
      conversationId: "conversation-multi-actor",
      sessionId: "turn-multi-actor",
      sliceId: 2,
      messages: [aliceMessage, bobMessage],
      actor: alice,
      trailingMessageProvenance: [{ authority: "instruction", actor: bob }],
    });

    // getAgentTurnSessionRecord re-materializes from the stored record and the
    // committed provenance, so this is also the continuation/materialization
    // path — it must reproduce the same first-seen-ordered set.
    const record = await getAgentTurnSessionRecord(
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
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-system-actor",
      sessionId: "turn-system-actor",
      sliceId: 1,
      state: "completed",
      // No actor: nothing is attributed as an instruction actor.
      piMessages: [userMessage("system dispatch input")],
    });

    const record = await getAgentTurnSessionRecord(
      "conversation-system-actor",
      "turn-system-actor",
    );
    expect(record?.actors).toEqual([]);
  });

  it("carries cumulative diagnostics across pause records", async () => {
    const { persistContinuationSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 1,
      state: "awaiting_resume",
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

    await persistContinuationSessionRecord({
      resumeReason: "timeout",
      conversationId: "conversation-1",
      sessionId: "turn-1",
      currentSliceId: 1,
      currentDurationMs: 2_250,
      currentUsage: {
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

    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-1",
      "turn-1",
    );
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
    const { persistContinuationSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { botConfig } = await import("@/chat/config");
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    const piMessages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "keep trying" }],
        timestamp: 1,
      },
    ];

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-timeout-cap",
      sessionId: "turn-timeout-cap",
      sliceId: botConfig.maxSlicesPerTurn,
      state: "awaiting_resume",
      piMessages,
      resumeReason: "timeout",
      cumulativeDurationMs: 12_000,
    });

    await expect(
      persistContinuationSessionRecord({
        resumeReason: "timeout",
        conversationId: "conversation-timeout-cap",
        sessionId: "turn-timeout-cap",
        currentSliceId: botConfig.maxSlicesPerTurn,
        currentDurationMs: 3_000,
        messages: piMessages,
        errorMessage: "timed out again",
      }),
    ).resolves.toMatchObject({
      state: "failed",
      sliceId: botConfig.maxSlicesPerTurn,
      cumulativeDurationMs: 15_000,
      errorMessage: expect.stringContaining("execution limit"),
      piMessages,
    });

    await expect(
      getAgentTurnSessionRecord("conversation-timeout-cap", "turn-timeout-cap"),
    ).resolves.toMatchObject({
      state: "failed",
      sliceId: botConfig.maxSlicesPerTurn,
      cumulativeDurationMs: 15_000,
      errorMessage: expect.stringContaining("execution limit"),
      piMessages,
    });
  });

  it("falls back to the last stored safe boundary when auth pause captures a non-continuable tail", async () => {
    const { persistAuthPauseSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    const safeBoundary: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "connect and answer" }],
        timestamp: 1,
      },
    ];

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-auth-tail",
      sessionId: "turn-auth-tail",
      sliceId: 1,
      state: "running",
      piMessages: safeBoundary,
    });

    const authSessionRecord = await persistAuthPauseSessionRecord({
      conversationId: "conversation-auth-tail",
      sessionId: "turn-auth-tail",
      currentSliceId: 1,
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
      state: "awaiting_resume",
      sliceId: 2,
      resumeReason: "auth",
      piMessages: safeBoundary,
    });

    await expect(
      getAgentTurnSessionRecord("conversation-auth-tail", "turn-auth-tail"),
    ).resolves.toMatchObject({
      state: "awaiting_resume",
      piMessages: safeBoundary,
    });
  });

  it("creates auth-pause records before a prompt checkpoint", async () => {
    const {
      loadTurnSessionRecord,
      persistAuthPauseSessionRecord,
      persistContinuationSessionRecord,
    } = await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    const authRecord = await persistAuthPauseSessionRecord({
      conversationId: "conversation-auth-empty",
      sessionId: "turn-auth-empty",
      currentSliceId: 1,
      messages: [],
      errorMessage: "auth pause",
    });

    expect(authRecord).toMatchObject({
      conversationId: "conversation-auth-empty",
      sessionId: "turn-auth-empty",
      state: "awaiting_resume",
      piMessages: [],
      resumeReason: "auth",
    });
    await expect(
      loadTurnSessionRecord({
        conversationId: "conversation-auth-empty",
        sessionId: "turn-auth-empty",
      }),
    ).resolves.toMatchObject({
      resumedFromSessionRecord: true,
      currentSliceId: 2,
    });

    await expect(
      persistContinuationSessionRecord({
        resumeReason: "timeout",
        conversationId: "conversation-timeout-empty",
        sessionId: "turn-timeout-empty",
        currentSliceId: 1,
        messages: [],
        errorMessage: "timeout",
      }),
    ).resolves.toBeUndefined();

    await expect(
      getAgentTurnSessionRecord(
        "conversation-timeout-empty",
        "turn-timeout-empty",
      ),
    ).resolves.toBeUndefined();
  });

  it("retries and surfaces completed session persistence failures", async () => {
    const getAgentTurnSessionRecord = vi.fn(async () => {
      throw new Error("state adapter unavailable");
    });
    vi.doMock("@/chat/state/turn-session", () => ({
      getAgentTurnSessionRecord,
      upsertAgentTurnSessionRecord: vi.fn(),
    }));
    const { persistCompletedSessionRecord } =
      await import("@/chat/services/turn-session-record");

    await expect(
      persistCompletedSessionRecord({
        conversationId: "conversation-1",
        sessionId: "turn-1",
        sliceId: 1,
        allMessages: [
          {
            role: "user",
            content: [{ type: "text", text: "help me" }],
            timestamp: 1,
          },
        ],
      }),
    ).rejects.toThrow("state adapter unavailable");
    expect(getAgentTurnSessionRecord).toHaveBeenCalledTimes(3);
  });

  it("retries the same completed totals without double-counting", async () => {
    const getAgentTurnSessionRecord = vi.fn(async () => ({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 2,
      state: "awaiting_resume",
      piMessages: [],
      piMessageProvenance: [],
      cumulativeDurationMs: 1_000,
      cumulativeUsage: { inputTokens: 10 },
    }));
    const upsertAgentTurnSessionRecord = vi
      .fn()
      .mockRejectedValueOnce(new Error("summary append failed"))
      .mockRejectedValueOnce(new Error("summary append failed"))
      .mockResolvedValue(undefined);
    vi.doMock("@/chat/state/turn-session", () => ({
      getAgentTurnSessionRecord,
      upsertAgentTurnSessionRecord,
    }));
    const { persistCompletedSessionRecord } =
      await import("@/chat/services/turn-session-record");

    await persistCompletedSessionRecord({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      currentDurationMs: 500,
      currentUsage: { inputTokens: 5 },
      allMessages: [userMessage("done")],
    });

    expect(getAgentTurnSessionRecord).toHaveBeenCalledTimes(1);
    expect(upsertAgentTurnSessionRecord).toHaveBeenCalledTimes(3);
    for (const [target] of upsertAgentTurnSessionRecord.mock.calls) {
      expect(target).toMatchObject({
        cumulativeDurationMs: 1_500,
        cumulativeUsage: { inputTokens: 15 },
      });
    }
  });

  it("keeps runtime bootstrap out of durable completed history", async () => {
    const { persistCompletedSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    await persistCompletedSessionRecord({
      conversationId: "conversation-completed",
      sessionId: "turn-completed",
      sliceId: 1,
      allMessages: [
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
      getAgentTurnSessionRecord("conversation-completed", "turn-completed"),
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
    const { persistCompletedSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    await persistCompletedSessionRecord({
      conversationId: "agent-dispatch:dispatch_atomic",
      sessionId: "dispatch:dispatch_atomic",
      sliceId: 4,
      allMessages: [userMessage("done")],
      destination: SLACK_DESTINATION,
      dispatchId: "dispatch_atomic",
      dispatchOutcome: "failed",
      resultMessageId: "1700000000.002",
      source: SLACK_SOURCE,
      surface: "api",
    });

    await expect(
      getAgentTurnSessionRecord(
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
    const { persistRunningSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
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
      persistRunningSessionRecord({
        conversationId: "conversation-1",
        sessionId: "turn-1",
        sliceId: 1,
        messages: userBoundary,
      }),
    ).resolves.toBe(true);

    await expect(
      persistRunningSessionRecord({
        conversationId: "conversation-1",
        sessionId: "turn-1",
        sliceId: 1,
        messages: unsafeAssistantBoundary,
      }),
    ).resolves.toBe(false);

    let sessionRecord = await getAgentTurnSessionRecord(
      "conversation-1",
      "turn-1",
    );
    expect(sessionRecord).toMatchObject({
      state: "running",
      piMessages: userBoundary,
    });

    await expect(
      persistRunningSessionRecord({
        conversationId: "conversation-1",
        sessionId: "turn-1",
        sliceId: 1,
        messages: toolResultBoundary,
      }),
    ).resolves.toBe(true);

    sessionRecord = await getAgentTurnSessionRecord("conversation-1", "turn-1");
    expect(sessionRecord).toMatchObject({
      state: "running",
      piMessages: toolResultBoundary,
    });
  });

  it("reports running record storage failures", async () => {
    vi.doMock("@/chat/state/turn-session", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("@/chat/state/turn-session")>();
      return {
        ...actual,
        upsertAgentTurnSessionRecord: vi.fn(async () => {
          throw new Error("storage unavailable");
        }),
      };
    });
    const { persistRunningSessionRecord } =
      await import("@/chat/services/turn-session-record");

    await expect(
      persistRunningSessionRecord({
        conversationId: "conversation-storage-failure",
        sessionId: "turn-storage-failure",
        sliceId: 1,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "help me" }],
            timestamp: 1,
          },
        ],
      }),
    ).resolves.toBe(false);
  });

  it("promotes the latest running record when timeout capture has no messages", async () => {
    const { persistContinuationSessionRecord, persistRunningSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const messages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "help me" }],
        timestamp: 1,
      },
    ];

    await persistRunningSessionRecord({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 1,
      messages,
    });

    await persistContinuationSessionRecord({
      resumeReason: "timeout",
      conversationId: "conversation-1",
      sessionId: "turn-1",
      currentSliceId: 1,
      messages: [],
      errorMessage: "provider stream interrupted",
    });

    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-1",
      "turn-1",
    );
    expect(sessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "timeout",
      sliceId: 2,
      piMessages: messages,
    });
  });

  it("rejects an implicit branch from committed agent history", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const user: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "help me" }],
      timestamp: 1,
    };
    const unsafeAssistant = assistantMessage("not committed", 2);
    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-branch",
      sessionId: "turn-branch",
      sliceId: 1,
      state: "running",
      piMessages: [user, unsafeAssistant],
    });
    await expect(
      upsertAgentTurnSessionRecord({
        conversationId: "conversation-branch",
        sessionId: "turn-branch",
        sliceId: 2,
        state: "awaiting_resume",
        piMessages: [user],
        resumeReason: "timeout",
      }),
    ).rejects.toThrow("changed before its committed boundary");
  });

  it("keeps older turn records pinned to their committed projection after reset", async () => {
    const {
      failAgentTurnSessionRecord,
      getAgentTurnSessionRecord,
      upsertAgentTurnSessionRecord,
    } = await import("@/chat/state/turn-session");
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

    const oldRecord = await upsertAgentTurnSessionRecord({
      conversationId: "conversation-projection-pin",
      sessionId: "turn-old",
      sliceId: 1,
      state: "awaiting_resume",
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
    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-projection-pin",
      sessionId: "turn-new",
      sliceId: 1,
      state: "completed",
      piMessages: [newRequest, newFollowup],
    });

    await expect(
      getAgentTurnSessionRecord("conversation-projection-pin", "turn-old"),
    ).resolves.toMatchObject({
      piMessages: [oldRequest],
    });

    await failAgentTurnSessionRecord({
      conversationId: "conversation-projection-pin",
      sessionId: "turn-old",
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
    const { loadTurnSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { getConversationEventStore } = await import("@/chat/db");
    const conversationId = "conversation-handoff-resume";
    const sessionId = "turn-handoff-resume";
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

    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 1,
      state: "awaiting_resume",
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
      loadTurnSessionRecord({ conversationId, sessionId }),
    ).resolves.toMatchObject({
      resumedFromSessionRecord: true,
      existingSessionRecord: {
        piMessages: [handoffSummary],
        turnStartMessageIndex: 0,
      },
    });
  });

  it("restores unmatched runtime context before an active-turn replacement", async () => {
    const { loadTurnSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
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

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-active-compaction-resume",
      sessionId: "turn-active-compaction-resume",
      sliceId: 1,
      state: "awaiting_resume",
      resumeReason: "yield",
      piMessages: [runtimeContext, instruction, summary],
    });

    const resumed = await loadTurnSessionRecord({
      conversationId: "conversation-active-compaction-resume",
      sessionId: "turn-active-compaction-resume",
    });

    expect(resumed.resumedFromSessionRecord).toBe(true);
    expect(resumed.existingSessionRecord?.piMessages).toEqual([
      runtimeContext,
      instruction,
      summary,
    ]);
  });

  it("restores mid-run AGENTS context at its causal position", async () => {
    const { loadTurnSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
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

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-agents-order-resume",
      sessionId: "turn-agents-order-resume",
      sliceId: 1,
      state: "awaiting_resume",
      resumeReason: "yield",
      piMessages: [instruction, agents, assistant],
    });

    const resumed = await loadTurnSessionRecord({
      conversationId: "conversation-agents-order-resume",
      sessionId: "turn-agents-order-resume",
    });

    expect(resumed.existingSessionRecord?.piMessages).toEqual([
      instruction,
      agents,
      assistant,
    ]);
  });
});
