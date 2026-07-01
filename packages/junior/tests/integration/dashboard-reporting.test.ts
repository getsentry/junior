import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Conversation,
  ConversationStore,
} from "@/chat/conversations/store";
import type { PiMessage } from "@/chat/pi/messages";
import type { AgentTurnSessionSummary } from "@/chat/state/turn-session";

vi.mock("@/chat/prompt", () => ({
  buildSystemPrompt: vi.fn(() => "[system prompt]"),
  buildTurnContextPrompt: vi.fn(() => null),
  JUNIOR_PERSONALITY: "",
  JUNIOR_WORLD: null,
}));

const SYSTEM_MESSAGE = {
  role: "system",
  parts: [{ type: "text", text: "[system prompt]" }],
};

const AGENT_TURN_SESSION_INDEX_KEY = "junior:agent_turn_session:index";
const AGENT_TURN_SESSION_INDEX_MAX_LENGTH = 5_000;
const ORIGINAL_ENV = { ...process.env };
const TEST_DATABASE_URL = ORIGINAL_ENV.DATABASE_URL;

if (!TEST_DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for dashboard reporting integration tests",
  );
}

function slackRequester(fullName: string, userId = "U1") {
  return {
    fullName,
    platform: "slack" as const,
    teamId: "T1",
    userId,
  };
}

function fixedConversationStore(
  conversations: Conversation[],
): ConversationStore {
  return {
    async get(args) {
      return conversations.find(
        (conversation) => conversation.conversationId === args.conversationId,
      );
    },
    async recordActivity() {},
    async recordExecution() {},
    async listByActivity(args = {}) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? conversations.length;
      return conversations
        .slice()
        .sort(
          (left, right) =>
            right.lastActivityAtMs - left.lastActivityAtMs ||
            left.conversationId.localeCompare(right.conversationId),
        )
        .slice(offset, offset + limit);
    },
  };
}

function indexedConversation(
  input: Partial<Conversation> &
    Pick<Conversation, "conversationId" | "createdAtMs" | "lastActivityAtMs">,
): Conversation {
  return {
    schemaVersion: 1,
    ...input,
    updatedAtMs: input.lastActivityAtMs,
    execution: {
      status: "idle",
      updatedAtMs: input.lastActivityAtMs,
      ...input.execution,
    },
  };
}

async function createStateReportingReader() {
  const { createStateConversationStore } =
    await import("@/chat/conversations/state");
  const { getStateAdapter } = await import("@/chat/state/adapter");
  const { readConversationReport, readConversationStatsReport } =
    await import("@/reporting/conversations");
  const conversationStore = createStateConversationStore(getStateAdapter());
  return {
    conversationStore,
    readConversationReport,
    readConversationStatsReport,
  };
}

describe("dashboard reporting", () => {
  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      DATABASE_URL: TEST_DATABASE_URL,
      JUNIOR_STATE_ADAPTER: "memory",
    };
    vi.resetModules();
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    const { closeDb } = await import("@/chat/db");
    await closeDb();
    await disconnectStateAdapter();
    vi.useRealTimers();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("indexes recent turn session summaries", async () => {
    const { listAgentTurnSessionSummaries, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    await upsertAgentTurnSessionRecord({
      conversationId: "slack:C1:111",
      sessionId: "turn-1",
      sliceId: 1,
      state: "running",
      piMessages: [],
    });
    await upsertAgentTurnSessionRecord({
      conversationId: "slack:C1:111",
      sessionId: "turn-1",
      sliceId: 2,
      state: "completed",
      piMessages: [],
      cumulativeDurationMs: 1_200,
      errorMessage: "provider failed with sensitive details",
      loadedSkillNames: ["triage"],
    });
    await upsertAgentTurnSessionRecord({
      conversationId: "slack:C2:222",
      sessionId: "turn-2",
      sliceId: 1,
      state: "awaiting_resume",
      piMessages: [],
      resumeReason: "timeout",
    });

    const summaries = await listAgentTurnSessionSummaries();
    const turn1 = summaries.find((summary) => summary.sessionId === "turn-1");
    const turn2 = summaries.find((summary) => summary.sessionId === "turn-2");

    expect(
      summaries.filter((summary) => summary.sessionId === "turn-1"),
    ).toHaveLength(1);
    expect(turn1).toMatchObject({
      conversationId: "slack:C1:111",
      sessionId: "turn-1",
      sliceId: 2,
      state: "completed",
      cumulativeDurationMs: 1_200,
      loadedSkillNames: ["triage"],
    });
    expect(turn1?.startedAtMs).toBeLessThanOrEqual(turn1?.updatedAtMs ?? 0);
    expect(turn1).not.toHaveProperty("errorMessage");
    expect(turn2).toMatchObject({
      conversationId: "slack:C2:222",
      cumulativeDurationMs: 0,
      sessionId: "turn-2",
      state: "awaiting_resume",
      resumeReason: "timeout",
    });
  });

  it("reads conversation title details when context is absent", async () => {
    const { getConversationDetails, setConversationTitle } =
      await import("@/chat/state/conversation-details");

    await setConversationTitle("slack:C1:111", {
      displayTitle: "Incident Triage",
      titleSourceMessageId: "msg-1",
    });

    await expect(getConversationDetails("slack:C1:111")).resolves.toMatchObject(
      {
        conversationId: "slack:C1:111",
        displayTitle: "Incident Triage",
        titleSourceMessageId: "msg-1",
      },
    );
  });

  it("lists recent conversations through reporting", async () => {
    const { getConversationStore } = await import("@/chat/db");
    const { createJuniorReporting } = await import("@/reporting");
    const conversationStore = getConversationStore();

    await conversationStore.recordActivity({
      conversationId: "slack:C1:111",
      channelName: "incidents",
      nowMs: 1_000,
      source: "slack",
      title: "Incident follow-up",
    });

    const reporting = createJuniorReporting();

    await expect(reporting.listRecentConversations()).resolves.toEqual([
      expect.objectContaining({
        channelName: "incidents",
        conversationId: "slack:C1:111",
        displayTitle: expect.any(String),
        source: "slack",
        status: "completed",
      }),
    ]);
  });

  it("mirrors local turn sessions as local conversation summaries", async () => {
    const { recordAgentTurnSessionSummary } =
      await import("@/chat/state/turn-session");
    const { getConversationStore } = await import("@/chat/db");
    const conversationId = "local:workspace:run-123";

    await recordAgentTurnSessionSummary({
      conversationId,
      destination: {
        platform: "local",
        conversationId,
      },
      sessionId: "local-turn-1",
      sliceId: 1,
      state: "completed",
      surface: "internal",
      ttlMs: 60_000,
    });

    await expect(
      getConversationStore().get({
        conversationId,
      }),
    ).resolves.toMatchObject({
      conversationId,
      source: "local",
    });
  });

  it("redacts private conversation summaries", async () => {
    const { getConversationStore } = await import("@/chat/db");
    const { createJuniorReporting } = await import("@/reporting");
    const conversationStore = getConversationStore();

    await conversationStore.recordActivity({
      conversationId: "slack:G1:222",
      channelName: "private-incident-room",
      nowMs: 1_000,
      source: "slack",
      title: "Sensitive escalation",
    });

    const summaries = await createJuniorReporting().listRecentConversations();

    expect(JSON.stringify(summaries)).not.toContain("private-incident-room");
    expect(JSON.stringify(summaries)).not.toContain("Sensitive escalation");
    expect(summaries[0]).toMatchObject({
      conversationId: "slack:G1:222",
      status: "completed",
    });
  });

  it("refreshes conversation context ttl without replacing origin context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const { THREAD_STATE_TTL_MS } = await import("chat");
    const { getConversationDetails, initConversationContext } =
      await import("@/chat/state/conversation-details");
    const startedAtMs = Date.now();

    await initConversationContext("slack:C1:111", {
      channelName: "first-channel",
      originRequester: { fullName: "First Requester" },
      originSurface: "slack",
      startedAtMs,
    });

    vi.setSystemTime(Date.now() + THREAD_STATE_TTL_MS - 1_000);
    await initConversationContext("slack:C1:111", {
      channelName: "later-channel",
      originRequester: { fullName: "Later Requester" },
      originSurface: "slack",
      startedAtMs: Date.now(),
    });

    vi.setSystemTime(Date.now() + 2_000);
    await expect(getConversationDetails("slack:C1:111")).resolves.toMatchObject(
      {
        channelName: "first-channel",
        originRequester: { fullName: "First Requester" },
        startedAtMs,
      },
    );
  });

  it("does not replace malformed conversation context with later turn metadata", async () => {
    const {
      getConversationDetails,
      initConversationContext,
      setConversationTitle,
    } = await import("@/chat/state/conversation-details");
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const { THREAD_STATE_TTL_MS } = await import("chat");
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();

    await stateAdapter.set(
      "junior:conversation:slack:C1:malformed:context",
      { channelName: "first-channel" },
      THREAD_STATE_TTL_MS,
    );
    await setConversationTitle("slack:C1:malformed", {
      displayTitle: "Existing Title",
    });

    await initConversationContext("slack:C1:malformed", {
      channelName: "later-channel",
      originRequester: { fullName: "Later Requester" },
      originSurface: "slack",
      startedAtMs: Date.now(),
    });

    const details = await getConversationDetails("slack:C1:malformed");

    expect(details).toMatchObject({
      conversationId: "slack:C1:malformed",
      displayTitle: "Existing Title",
    });
    expect(details).not.toHaveProperty("channelName");
    expect(details).not.toHaveProperty("originRequester");
    expect(details).not.toHaveProperty("startedAtMs");
  });

  it("uses conversation details title when conversation turns are absent", async () => {
    const { initConversationContext, setConversationTitle } =
      await import("@/chat/state/conversation-details");
    const { createJuniorReporting } = await import("@/reporting");

    await initConversationContext("slack:C1:details-only", {
      channelName: "proj-alpha",
      originSurface: "slack",
      startedAtMs: Date.now(),
    });
    await setConversationTitle("slack:C1:details-only", {
      displayTitle: "Details Only Title",
    });

    const report = await createJuniorReporting().getConversation(
      "slack:C1:details-only",
    );

    expect(report).toMatchObject({
      conversationId: "slack:C1:details-only",
      displayTitle: "Details Only Title",
      runs: [],
    });
  });

  it("reports conversation-index detail when turn summaries are absent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    const { requestConversationWork } =
      await import("@/chat/task-execution/store");
    const { createJuniorReporting } = await import("@/reporting");

    await requestConversationWork({
      conversationId: "slack:C1:index-only",
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "C1",
      },
      nowMs: Date.now(),
    });

    const report = await createJuniorReporting().getConversation(
      "slack:C1:index-only",
    );

    expect(report).toMatchObject({
      conversationId: "slack:C1:index-only",
      runs: [
        expect.objectContaining({
          id: "slack:C1:index-only",
          status: "active",
          transcriptAvailable: false,
          transcript: [],
        }),
      ],
    });
  });

  it("reports aggregate conversation stats beyond the conversation feed cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    const { recordAgentTurnSessionSummary } =
      await import("@/chat/state/turn-session");
    const { createJuniorReporting } = await import("@/reporting");

    for (let index = 0; index < 55; index += 1) {
      await recordAgentTurnSessionSummary({
        channelName: "proj-alpha",
        conversationId: `slack:C1:${index}`,
        cumulativeDurationMs: index + 1,
        requester: slackRequester("Avery"),
        sessionId: `turn-${index}`,
        sliceId: 1,
        startedAtMs: Date.now() - index * 1000,
        state: "completed",
      });
    }

    const reporting = createJuniorReporting();
    const feed = await reporting.listConversations();
    const stats = await reporting.getConversationStats();

    expect(feed.conversations).toHaveLength(50);
    expect(stats).toMatchObject({
      conversations: 55,
      requesters: [
        expect.objectContaining({
          conversations: 55,
          label: "Avery",
        }),
      ],
      sampleLimit: 5_000,
      sampleSize: 55,
      source: "conversation_index",
      truncated: false,
      runs: 55,
    });
  });

  it("reports aggregate conversation stats by requester and location", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    const { readConversationStatsReport } =
      await import("@/reporting/conversations");
    const stats = await readConversationStatsReport({
      conversationStore: fixedConversationStore([
        indexedConversation({
          channelName: "old-project",
          conversationId: "slack:C2:300",
          createdAtMs: Date.parse("2026-05-20T10:00:00.000Z"),
          lastActivityAtMs: Date.parse("2026-05-20T10:02:00.000Z"),
          requester: { fullName: "Casey" },
          source: "slack",
        }),
        indexedConversation({
          channelName: "proj-alpha",
          conversationId: "slack:C1:100",
          createdAtMs: Date.parse("2026-06-01T10:00:00.000Z"),
          execution: {
            status: "failed",
            updatedAtMs: Date.parse("2026-06-01T10:04:00.000Z"),
          },
          lastActivityAtMs: Date.parse("2026-06-01T10:04:00.000Z"),
          requester: { fullName: "Blake" },
          source: "slack",
        }),
        indexedConversation({
          conversationId: "slack:D1:200",
          createdAtMs: Date.parse("2026-06-04T11:00:00.000Z"),
          execution: {
            status: "awaiting_resume",
            updatedAtMs: Date.parse("2026-06-04T11:02:00.000Z"),
          },
          lastActivityAtMs: Date.parse("2026-06-04T11:02:00.000Z"),
          requester: { fullName: "Avery" },
          source: "slack",
        }),
      ]),
    });

    expect(stats).toMatchObject({
      active: 1,
      conversations: 2,
      durationMs: 0,
      failed: 1,
      requesters: [
        {
          active: 1,
          conversations: 1,
          durationMs: 0,
          failed: 0,
          hung: 0,
          label: "Avery",
          runs: 1,
        },
        {
          active: 0,
          conversations: 1,
          durationMs: 0,
          failed: 1,
          hung: 0,
          label: "Blake",
          runs: 1,
        },
      ],
      runs: 2,
    });
    expect(
      stats.locations.map((item) => ({
        conversations: item.conversations,
        durationMs: item.durationMs,
        label: item.label,
      })),
    ).toEqual([
      { conversations: 1, durationMs: 0, label: "#proj-alpha" },
      { conversations: 1, durationMs: 0, label: "Direct Message" },
    ]);
  });

  it("reports conversation feed from origin details when summaries omit metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    const { initConversationContext } =
      await import("@/chat/state/conversation-details");
    const { recordAgentTurnSessionSummary } =
      await import("@/chat/state/turn-session");
    const { createJuniorReporting } = await import("@/reporting");

    await initConversationContext("slack:C1:100", {
      channelName: "proj-alpha",
      originRequester: { fullName: "Origin Requester" },
      originSurface: "slack",
      startedAtMs: Date.parse("2026-06-04T10:00:00.000Z"),
    });
    await recordAgentTurnSessionSummary({
      conversationId: "slack:C1:100",
      cumulativeDurationMs: 1_000,
      requester: slackRequester("Later Requester"),
      sessionId: "turn-1",
      sliceId: 1,
      startedAtMs: Date.parse("2026-06-04T10:05:00.000Z"),
      state: "completed",
    });

    const feed = await createJuniorReporting().listConversations();

    expect(
      feed.conversations.map((conversation) => conversation.requesterIdentity),
    ).toEqual([
      expect.objectContaining({
        fullName: "Origin Requester",
      }),
    ]);
    expect(feed.conversations).toEqual([
      expect.objectContaining({
        channelName: "proj-alpha",
      }),
    ]);
  });

  it("reports aggregate scheduler and API locations from stored turn surfaces", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    const { recordAgentTurnSessionSummary } =
      await import("@/chat/state/turn-session");
    const { createJuniorReporting } = await import("@/reporting");

    await recordAgentTurnSessionSummary({
      conversationId: "agent-dispatch:dispatch_scheduler",
      cumulativeDurationMs: 2_000,
      requester: slackRequester("Scheduler"),
      sessionId: "dispatch:scheduler",
      sliceId: 1,
      state: "completed",
      surface: "scheduler",
    });
    await recordAgentTurnSessionSummary({
      conversationId: "agent-dispatch:dispatch_api",
      cumulativeDurationMs: 1_000,
      requester: slackRequester("API"),
      sessionId: "dispatch:api",
      sliceId: 1,
      state: "completed",
      surface: "api",
    });

    const stats = await createJuniorReporting().getConversationStats();

    expect(stats.locations.map((item) => item.label)).toEqual([
      "API",
      "Scheduler",
    ]);
  });

  it("reports failed conversation stats from SQL conversation records", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    const { recordAgentTurnSessionSummary } =
      await import("@/chat/state/turn-session");
    const { createJuniorReporting } = await import("@/reporting");

    await recordAgentTurnSessionSummary({
      channelName: "proj-alpha",
      conversationId: "slack:C1:failed",
      requester: slackRequester("Avery"),
      sessionId: "turn-failed",
      sliceId: 1,
      state: "failed",
      surface: "slack",
    });

    const stats = await createJuniorReporting().getConversationStats();

    expect(stats).toMatchObject({
      failed: 1,
      runs: 1,
      requesters: [
        expect.objectContaining({
          failed: 1,
          label: "Avery",
        }),
      ],
    });
  });

  it("caps aggregate conversation stats before building index counts", async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.parse("2026-06-04T10:00:00.000Z");
    const latestAtMs = startedAtMs + 5_001 * 1000;
    vi.setSystemTime(new Date(latestAtMs));
    const { readConversationStatsReport } =
      await import("@/reporting/conversations");
    const conversationStore = fixedConversationStore([
      indexedConversation({
        conversationId: "slack:C1:baseline",
        createdAtMs: startedAtMs,
        lastActivityAtMs: latestAtMs,
        requester: { fullName: "Blake" },
        source: "slack",
      }),
      ...Array.from({ length: 5_000 }, (_, index) =>
        indexedConversation({
          conversationId: `slack:C_FILL:${index}`,
          createdAtMs: startedAtMs + (index + 1) * 1000,
          lastActivityAtMs: startedAtMs + (index + 1) * 1000,
          requester: { fullName: "Filler" },
          source: "slack",
        }),
      ),
    ]);

    const stats = await readConversationStatsReport({ conversationStore });
    expect(stats.truncated).toBe(true);
    expect(stats.sampleSize).toBe(5_000);
    expect(stats.runs).toBe(5_000);
  });

  it("marks aggregate conversation stats truncated when the sample cap is reached", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    const nowMs = Date.parse("2026-06-04T12:00:00.000Z");
    const { readConversationStatsReport } =
      await import("@/reporting/conversations");
    const conversationStore = fixedConversationStore(
      Array.from({ length: 5_001 }, (_, index) =>
        indexedConversation({
          conversationId: `slack:C1:${index}`,
          createdAtMs: nowMs - index * 1000,
          lastActivityAtMs: nowMs - index * 1000,
          source: "slack",
        }),
      ),
    );

    const stats = await readConversationStatsReport({ conversationStore });

    expect(stats).toMatchObject({
      sampleLimit: 5_000,
      sampleSize: 5_000,
      truncated: true,
    });
  });

  it("reports only the current turn transcript from session history", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { createJuniorReporting } = await import("@/reporting");

    await upsertAgentTurnSessionRecord({
      conversationId: "slack:C1:222",
      sessionId: "turn-current",
      sliceId: 1,
      state: "completed",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "previous question" }],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "previous answer" }],
          timestamp: 2,
        },
        {
          role: "user",
          content: [{ type: "text", text: "current question" }],
          timestamp: 3,
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "I should use a tool" },
            {
              type: "toolCall",
              name: "search",
              arguments: { query: "current question" },
            },
          ],
          timestamp: 4,
        },
        {
          role: "toolResult",
          toolCallId: "search-1",
          name: "search",
          content: [{ type: "text", text: "tool result" }],
          timestamp: 5,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "current answer" }],
          timestamp: 6,
        },
      ] as PiMessage[],
    });

    const report =
      await createJuniorReporting().getConversation("slack:C1:222");

    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({
      transcriptMessageCount: 2,
    });
    expect(report.runs[0]!.transcript).toEqual([
      {
        role: "user",
        timestamp: 3,
        parts: [{ type: "text", text: "current question" }],
      },
      {
        role: "assistant",
        timestamp: 4,
        parts: [
          { type: "thinking", output: "I should use a tool" },
          {
            type: "tool_call",
            name: "search",
            input: { query: "current question" },
          },
        ],
      },
      {
        role: "toolResult",
        timestamp: 5,
        parts: [
          {
            type: "tool_result",
            id: "search-1",
            name: "search",
            output: "tool result",
          },
        ],
      },
      {
        role: "assistant",
        timestamp: 6,
        parts: [{ type: "text", text: "current answer" }],
      },
    ]);
  });

  it("reports private execution activity as safe metadata", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const {
      recordSubagentEnded,
      recordSubagentStarted,
      recordToolExecutionStarted,
    } = await import("@/chat/state/session-log");
    const { createJuniorReporting } = await import("@/reporting");

    await upsertAgentTurnSessionRecord({
      conversationId: "slack:G1:activity",
      sessionId: "turn-activity",
      sliceId: 1,
      state: "completed",
      turnStartMessageIndex: 0,
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "current question" }],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "advisor-call-1",
          name: "advisor",
          content: [{ type: "text", text: "advisor result" }],
          timestamp: 4,
        },
      ] as PiMessage[],
    });
    await recordToolExecutionStarted({
      conversationId: "slack:G1:activity",
      sessionId: "turn-activity",
      createdAtMs: 2,
      toolCallId: "advisor-call-1",
      toolName: "advisor",
      args: { question: "private question", context: "private context" },
      ttlMs: 60_000,
    });
    await recordSubagentStarted({
      conversationId: "slack:G1:activity",
      sessionId: "turn-activity",
      createdAtMs: 3,
      historyMode: "shared",
      parentConversationId: "slack:G1:activity",
      parentSessionId: "turn-activity",
      parentToolCallId: "advisor-call-1",
      subagentInvocationId: "advisor-call-1",
      subagentKind: "advisor",
      transcriptRef: {
        type: "advisor_session",
        parentConversationId: "slack:G1:activity",
        key: "junior:slack:G1:activity:advisor_session",
      },
      ttlMs: 60_000,
    });
    await recordSubagentEnded({
      conversationId: "slack:G1:activity",
      sessionId: "turn-activity",
      createdAtMs: 5,
      outcome: "success",
      subagentInvocationId: "advisor-call-1",
      ttlMs: 60_000,
    });

    const report =
      await createJuniorReporting().getConversation("slack:G1:activity");

    expect(report.runs[0]?.activity).toEqual([
      expect.objectContaining({
        type: "tool_execution",
        toolCallId: "advisor-call-1",
        toolName: "advisor",
        status: "completed",
        redacted: true,
        inputKeys: ["question", "context"],
        subagents: [
          expect.objectContaining({
            type: "subagent",
            id: "advisor-call-1",
            outcome: "success",
            parentToolCallId: "advisor-call-1",
            status: "success",
            subagentKind: "advisor",
          }),
        ],
      }),
    ]);
    expect(JSON.stringify(report.runs[0]?.activity)).not.toContain(
      "private question",
    );
  });

  it("loads advisor subagent transcript history from a shared advisor session", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const {
      recordSubagentEnded,
      recordSubagentStarted,
      recordToolExecutionStarted,
    } = await import("@/chat/state/session-log");
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const { createJuniorReporting } = await import("@/reporting");

    const conversationId = "slack:C1:advisor-slices";
    const runId = "turn-advisor-slices";
    const advisorSessionKey = `junior:${conversationId}:advisor_session`;
    const advisorMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "first advisor question" }],
        timestamp: 10,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "first advisor answer" }],
        timestamp: 20,
      },
      {
        role: "user",
        content: [{ type: "text", text: "second advisor question" }],
        timestamp: 30,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "second advisor answer" }],
        timestamp: 40,
      },
      {
        role: "user",
        content: [{ type: "text", text: "third advisor question" }],
        timestamp: 50,
      },
    ] as PiMessage[];
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await stateAdapter.set(advisorSessionKey, advisorMessages, 60_000);

    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: runId,
      sliceId: 1,
      state: "completed",
      turnStartMessageIndex: 0,
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "make dashboard change" }],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "advisor-plan",
          name: "advisor",
          content: [{ type: "text", text: "plan result" }],
          timestamp: 25,
        },
        {
          role: "toolResult",
          toolCallId: "advisor-review",
          name: "advisor",
          content: [{ type: "text", text: "review result" }],
          timestamp: 45,
        },
      ] as PiMessage[],
    });

    for (const toolCallId of ["advisor-plan", "advisor-review"]) {
      await recordToolExecutionStarted({
        conversationId,
        sessionId: runId,
        createdAtMs: toolCallId === "advisor-plan" ? 2 : 30,
        toolCallId,
        toolName: "advisor",
        args: { question: toolCallId },
        ttlMs: 60_000,
      });
      await recordSubagentStarted({
        conversationId,
        sessionId: runId,
        createdAtMs: toolCallId === "advisor-plan" ? 3 : 31,
        historyMode: "shared",
        parentConversationId: conversationId,
        parentSessionId: runId,
        parentToolCallId: toolCallId,
        subagentInvocationId: toolCallId,
        subagentKind: "advisor",
        transcriptRef: {
          type: "advisor_session",
          parentConversationId: conversationId,
          key: advisorSessionKey,
        },
        ttlMs: 60_000,
      });
      await recordSubagentEnded({
        conversationId,
        sessionId: runId,
        createdAtMs: toolCallId === "advisor-plan" ? 25 : 45,
        outcome: "success",
        subagentInvocationId: toolCallId,
        transcriptStartMessageIndex: toolCallId === "advisor-plan" ? 0 : 2,
        transcriptEndMessageIndex: toolCallId === "advisor-plan" ? 2 : 4,
        ttlMs: 60_000,
      });
    }

    const reporting = createJuniorReporting();
    const report = await reporting.getConversation(conversationId);
    expect(report.runs[0]?.activity?.[0]).toMatchObject({
      toolCallId: "advisor-plan",
      subagents: [
        expect.objectContaining({
          id: "advisor-plan",
          transcriptAvailable: true,
        }),
      ],
    });

    const first = await reporting.getConversationSubagentTranscript(
      conversationId,
      runId,
      "advisor-plan",
    );
    const second = await reporting.getConversationSubagentTranscript(
      conversationId,
      runId,
      "advisor-review",
    );

    expect(first.subagentConversationId).toBe(advisorSessionKey);
    const encodedAdvisorSessionKey = encodeURIComponent(advisorSessionKey);
    expect(
      first.subagentSentryConversationUrl === undefined ||
        first.subagentSentryConversationUrl.includes(encodedAdvisorSessionKey),
    ).toBe(true);
    expect(JSON.stringify(first.transcript)).toContain(
      "first advisor question",
    );
    expect(JSON.stringify(first.transcript)).not.toContain(
      "second advisor question",
    );
    expect(JSON.stringify(second.transcript)).toContain("first advisor answer");
    expect(JSON.stringify(second.transcript)).toContain(
      "second advisor answer",
    );
    expect(JSON.stringify(second.transcript)).not.toContain(
      "third advisor question",
    );
  });

  it("redacts advisor subagent transcript history for private conversations", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const {
      recordSubagentEnded,
      recordSubagentStarted,
      recordToolExecutionStarted,
    } = await import("@/chat/state/session-log");
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const { createJuniorReporting } = await import("@/reporting");

    const conversationId = "slack:D1:advisor-private";
    const runId = "turn-advisor-private";
    const toolCallId = "advisor-private";
    const advisorSessionKey = `junior:${conversationId}:advisor_session`;
    const privateAdvisorText = "private advisor question";
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await stateAdapter.set(
      advisorSessionKey,
      [
        {
          role: "user",
          content: [{ type: "text", text: privateAdvisorText }],
          timestamp: 10,
        },
      ] as PiMessage[],
      60_000,
    );

    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: runId,
      sliceId: 1,
      state: "completed",
      turnStartMessageIndex: 0,
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "private parent request" }],
          timestamp: 1,
        },
      ] as PiMessage[],
    });
    await recordToolExecutionStarted({
      conversationId,
      sessionId: runId,
      createdAtMs: 2,
      toolCallId,
      toolName: "advisor",
      args: { question: privateAdvisorText },
      ttlMs: 60_000,
    });
    await recordSubagentStarted({
      conversationId,
      sessionId: runId,
      createdAtMs: 3,
      historyMode: "shared",
      parentConversationId: conversationId,
      parentSessionId: runId,
      parentToolCallId: toolCallId,
      subagentInvocationId: toolCallId,
      subagentKind: "advisor",
      transcriptRef: {
        type: "advisor_session",
        parentConversationId: conversationId,
        key: advisorSessionKey,
      },
      ttlMs: 60_000,
    });
    await recordSubagentEnded({
      conversationId,
      sessionId: runId,
      createdAtMs: 10,
      outcome: "success",
      subagentInvocationId: toolCallId,
      transcriptStartMessageIndex: 0,
      transcriptEndMessageIndex: 1,
      ttlMs: 60_000,
    });

    const reporting = createJuniorReporting();
    const parent = await reporting.getConversation(conversationId);
    expect(JSON.stringify(parent.runs[0]?.activity ?? [])).not.toContain(
      "transcriptAvailable",
    );

    const transcript = await reporting.getConversationSubagentTranscript(
      conversationId,
      runId,
      toolCallId,
    );

    expect(transcript.subagentConversationId).toBe(advisorSessionKey);
    expect(transcript.transcriptAvailable).toBe(false);
    expect(transcript.transcriptRedacted).toBe(true);
    expect(transcript.transcript).toEqual([]);
    expect(JSON.stringify(transcript)).not.toContain(privateAdvisorText);
  });

  it("derives unfinished subagent status from completed parent tool results", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { recordSubagentStarted, recordToolExecutionStarted } =
      await import("@/chat/state/session-log");
    const { createJuniorReporting } = await import("@/reporting");

    await upsertAgentTurnSessionRecord({
      conversationId: "slack:C1:activity-parent-result",
      sessionId: "turn-parent-result",
      sliceId: 1,
      state: "completed",
      turnStartMessageIndex: 0,
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "current question" }],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "advisor-call-parent",
          name: "advisor",
          content: [{ type: "text", text: "advisor result" }],
          timestamp: 4,
        },
      ] as PiMessage[],
    });
    await recordToolExecutionStarted({
      conversationId: "slack:C1:activity-parent-result",
      sessionId: "turn-parent-result",
      createdAtMs: 2,
      toolCallId: "advisor-call-parent",
      toolName: "advisor",
      args: { question: "public question" },
      ttlMs: 60_000,
    });
    await recordSubagentStarted({
      conversationId: "slack:C1:activity-parent-result",
      sessionId: "turn-parent-result",
      createdAtMs: 3,
      historyMode: "shared",
      parentConversationId: "slack:C1:activity-parent-result",
      parentSessionId: "turn-parent-result",
      parentToolCallId: "advisor-call-parent",
      subagentInvocationId: "advisor-call-parent",
      subagentKind: "advisor",
      transcriptRef: {
        type: "advisor_session",
        parentConversationId: "slack:C1:activity-parent-result",
        key: "junior:slack:C1:activity-parent-result:advisor_session",
      },
      ttlMs: 60_000,
    });

    const report = await createJuniorReporting().getConversation(
      "slack:C1:activity-parent-result",
    );

    expect(report.runs[0]?.activity).toEqual([
      expect.objectContaining({
        type: "tool_execution",
        status: "completed",
        subagents: [
          expect.objectContaining({
            type: "subagent",
            id: "advisor-call-parent",
            parentToolCallId: "advisor-call-parent",
            status: "completed",
          }),
        ],
      }),
    ]);
  });

  it("keeps the initial prompt when steering adds another user message", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { createJuniorReporting } = await import("@/reporting");

    await upsertAgentTurnSessionRecord({
      conversationId: "slack:C1:steering-transcript",
      sessionId: "turn-steering",
      sliceId: 1,
      state: "completed",
      turnStartMessageIndex: 2,
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "previous question" }],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "previous answer" }],
          timestamp: 2,
        },
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 3,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "working" }],
          timestamp: 4,
        },
        {
          role: "user",
          content: [{ type: "text", text: "steering message" }],
          timestamp: 5,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          timestamp: 6,
        },
      ] as PiMessage[],
    });

    const report = await createJuniorReporting().getConversation(
      "slack:C1:steering-transcript",
    );

    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({
      transcriptMessageCount: 4,
    });
    expect(report.runs[0]!.transcript).toEqual([
      {
        role: "user",
        timestamp: 3,
        parts: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        timestamp: 4,
        parts: [{ type: "text", text: "working" }],
      },
      {
        role: "user",
        timestamp: 5,
        parts: [{ type: "text", text: "steering message" }],
      },
      {
        role: "assistant",
        timestamp: 6,
        parts: [{ type: "text", text: "done" }],
      },
    ]);
  });

  it("reports a conversation after newer turns evict it from the global index", async () => {
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const { THREAD_STATE_TTL_MS } = await import("chat");
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { conversationStore, readConversationReport } =
      await createStateReportingReader();

    await upsertAgentTurnSessionRecord({
      conversationStore,
      conversationId: "slack:C1:999",
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "C1",
      },
      source: {
        platform: "slack",
        type: "pub",
        teamId: "T123",
        channelId: "C1",
        threadTs: "999",
      },
      sessionId: "target-turn",
      sliceId: 1,
      state: "completed",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "target question" }],
          timestamp: 1,
        },
      ] as PiMessage[],
    });

    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    for (let index = 0; index < 5_005; index += 1) {
      const nowMs = Date.now();
      const summary: AgentTurnSessionSummary = {
        conversationId: `slack:C2:${index}`,
        cumulativeDurationMs: 0,
        lastProgressAtMs: nowMs,
        sessionId: `newer-turn-${index}`,
        sliceId: 1,
        startedAtMs: nowMs,
        state: "completed",
        updatedAtMs: nowMs,
        version: 0,
      };
      await stateAdapter.appendToList(AGENT_TURN_SESSION_INDEX_KEY, summary, {
        maxLength: AGENT_TURN_SESSION_INDEX_MAX_LENGTH,
        ttlMs: THREAD_STATE_TTL_MS,
      });
    }

    const report = await readConversationReport("slack:C1:999", {
      conversationStore,
    });

    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({
      id: "target-turn",
      transcriptAvailable: true,
    });
    expect(report.runs[0]!.transcript).toEqual([
      SYSTEM_MESSAGE,
      {
        role: "user",
        timestamp: 1,
        parts: [{ type: "text", text: "target question" }],
      },
    ]);
  }, 20_000);

  it("keeps earlier turn transcripts pinned to their committed log prefix", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { createJuniorReporting } = await import("@/reporting");

    await upsertAgentTurnSessionRecord({
      conversationId: "slack:C1:333",
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "C1",
      },
      source: {
        platform: "slack",
        type: "pub",
        teamId: "T123",
        channelId: "C1",
        threadTs: "333",
      },
      sessionId: "turn-one",
      sliceId: 1,
      state: "completed",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "first question" }],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "first answer" }],
          timestamp: 2,
        },
      ] as PiMessage[],
    });
    await upsertAgentTurnSessionRecord({
      conversationId: "slack:C1:333",
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "C1",
      },
      source: {
        platform: "slack",
        type: "pub",
        teamId: "T123",
        channelId: "C1",
        threadTs: "333",
      },
      sessionId: "turn-two",
      sliceId: 1,
      state: "completed",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "first question" }],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "first answer" }],
          timestamp: 2,
        },
        {
          role: "user",
          content: [{ type: "text", text: "second question" }],
          timestamp: 3,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "second answer" }],
          timestamp: 4,
        },
      ] as PiMessage[],
    });

    const report =
      await createJuniorReporting().getConversation("slack:C1:333");

    expect(report.runs).toHaveLength(2);
    expect(report.runs[0]).toMatchObject({ id: "turn-one" });
    expect(report.runs[0]!.transcript).toEqual([
      SYSTEM_MESSAGE,
      {
        role: "user",
        timestamp: 1,
        parts: [{ type: "text", text: "first question" }],
      },
      {
        role: "assistant",
        timestamp: 2,
        parts: [{ type: "text", text: "first answer" }],
      },
    ]);
    expect(report.runs[1]).toMatchObject({ id: "turn-two" });
    expect(report.runs[1]!.transcript).toEqual([
      {
        role: "user",
        timestamp: 3,
        parts: [{ type: "text", text: "second question" }],
      },
      {
        role: "assistant",
        timestamp: 4,
        parts: [{ type: "text", text: "second answer" }],
      },
    ]);
  });

  it("redacts dashboard transcripts for non-public conversations", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { persistThreadStateById } =
      await import("@/chat/runtime/thread-state");
    const { createJuniorReporting } = await import("@/reporting");
    const privateToolArgs = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [
        `privateKey${index}`,
        `private value ${index}`,
      ]),
    );

    // Store the generated title in thread state — the canonical location.
    await persistThreadStateById("slack:D1:222", {
      artifacts: { assistantTitle: "sensitive generated thread title" },
    });

    await upsertAgentTurnSessionRecord({
      conversationId: "slack:D1:222",
      sessionId: "turn-private",
      sliceId: 1,
      state: "completed",
      channelName: "secret-dm-name",
      requester: {
        email: "david@sentry.io",
        platform: "slack",
        teamId: "T1",
        userId: "U1",
      },
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "private question" }],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "private answer" },
            {
              type: "toolCall",
              name: "search",
              arguments: privateToolArgs,
            },
          ],
          timestamp: 2,
        },
      ] as PiMessage[],
      traceId: "0123456789abcdef0123456789abcdef",
    });

    const report =
      await createJuniorReporting().getConversation("slack:D1:222");

    expect(report.runs[0]).toMatchObject({
      displayTitle: "Direct Message",
      channelName: "Direct Message",
      id: "turn-private",
      requesterIdentity: {
        email: "david@sentry.io",
        slackUserId: "U1",
      },
      traceId: "0123456789abcdef0123456789abcdef",
      transcriptAvailable: false,
      transcriptMessageCount: 2,
      transcriptRedacted: true,
      transcriptRedactionReason: "non_public_conversation",
      transcript: [],
    });
    expect(report.runs[0]).not.toHaveProperty("requester");
    expect(JSON.stringify(report)).not.toContain("private question");
    expect(JSON.stringify(report)).not.toContain("private answer");
    expect(JSON.stringify(report)).not.toContain("private value");
    expect(JSON.stringify(report)).not.toContain(
      "sensitive generated thread title",
    );
    expect(JSON.stringify(report)).not.toContain("secret-dm-name");
    const toolCall = report.runs[0]!.transcriptMetadata?.[1]?.parts.find(
      (part) => part.type === "tool_call",
    );
    expect(toolCall?.inputKeys).toHaveLength(20);
    expect(toolCall?.inputKeys).toContain("privateKey0");
    expect(toolCall?.inputKeys).not.toContain("privateKey20");
  });

  it("marks expired private transcripts as privacy redacted", async () => {
    const { recordAgentTurnSessionSummary } =
      await import("@/chat/state/turn-session");
    const { createJuniorReporting } = await import("@/reporting");

    await recordAgentTurnSessionSummary({
      conversationId: "slack:D1:333",
      sessionId: "turn-private-expired",
      sliceId: 1,
      state: "completed",
    });

    const report =
      await createJuniorReporting().getConversation("slack:D1:333");

    expect(report.runs[0]).toMatchObject({
      displayTitle: "Direct Message",
      channelName: "Direct Message",
      id: "turn-private-expired",
      transcriptAvailable: false,
      transcriptMetadata: [],
      transcriptRedacted: true,
      transcriptRedactionReason: "non_public_conversation",
      transcript: [],
    });
  });
});
