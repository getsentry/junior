import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";

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

const ORIGINAL_ENV = { ...process.env };

describe("dashboard reporting", () => {
  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
    };
    vi.resetModules();
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
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

  it("reports aggregate conversation stats beyond the session feed cap", async () => {
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
        requester: { fullName: "Avery" },
        sessionId: `turn-${index}`,
        sliceId: 1,
        startedAtMs: Date.now() - index * 1000,
        state: "completed",
      });
    }

    const reporting = createJuniorReporting();
    const sessions = await reporting.getSessions();
    const stats = await reporting.getConversationStats();

    expect(sessions.sessions).toHaveLength(50);
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
    const { recordAgentTurnSessionSummary } =
      await import("@/chat/state/turn-session");
    const { createJuniorReporting } = await import("@/reporting");

    vi.setSystemTime(new Date("2026-05-20T10:02:00.000Z"));
    await recordAgentTurnSessionSummary({
      channelName: "old-project",
      conversationId: "slack:C2:300",
      cumulativeDurationMs: 8_000,
      cumulativeUsage: { totalTokens: 500 },
      requester: { fullName: "Casey" },
      sessionId: "old-turn",
      sliceId: 1,
      startedAtMs: Date.parse("2026-05-20T10:00:00.000Z"),
      state: "completed",
    });
    vi.setSystemTime(new Date("2026-06-01T10:02:00.000Z"));
    await recordAgentTurnSessionSummary({
      channelName: "proj-alpha",
      conversationId: "slack:C1:100",
      cumulativeDurationMs: 1_000,
      cumulativeUsage: { inputTokens: 10, outputTokens: 5 },
      requester: { fullName: "Avery" },
      sessionId: "turn-1",
      sliceId: 1,
      startedAtMs: Date.parse("2026-06-01T10:00:00.000Z"),
      state: "completed",
    });
    vi.setSystemTime(new Date("2026-06-01T10:04:00.000Z"));
    await recordAgentTurnSessionSummary({
      channelName: "proj-alpha",
      conversationId: "slack:C1:100",
      cumulativeDurationMs: 2_000,
      cumulativeUsage: { totalTokens: 20 },
      requester: { fullName: "Blake" },
      sessionId: "turn-2",
      sliceId: 1,
      startedAtMs: Date.parse("2026-06-01T10:03:00.000Z"),
      state: "failed",
    });
    vi.setSystemTime(new Date("2026-06-04T11:02:00.000Z"));
    await recordAgentTurnSessionSummary({
      conversationId: "slack:D1:200",
      cumulativeDurationMs: 3_000,
      requester: { fullName: "Avery" },
      sessionId: "turn-3",
      sliceId: 1,
      startedAtMs: Date.parse("2026-06-04T11:00:00.000Z"),
      state: "awaiting_resume",
    });

    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    const stats = await createJuniorReporting().getConversationStats();

    expect(stats).toMatchObject({
      active: 0,
      conversations: 2,
      durationMs: 5_000,
      failed: 1,
      requesters: [
        {
          active: 0,
          conversations: 2,
          durationMs: 4_000,
          failed: 0,
          hung: 0,
          label: "Avery",
          tokens: 15,
          runs: 2,
        },
        {
          active: 0,
          conversations: 1,
          durationMs: 1_000,
          failed: 1,
          hung: 0,
          label: "Blake",
          tokens: 5,
          runs: 1,
        },
      ],
      tokens: 20,
      runs: 3,
    });
    expect(
      stats.locations.map((item) => ({
        conversations: item.conversations,
        durationMs: item.durationMs,
        label: item.label,
      })),
    ).toEqual([
      { conversations: 1, durationMs: 2_000, label: "#proj-alpha" },
      { conversations: 1, durationMs: 3_000, label: "Direct Message" },
    ]);
  });

  it("reports aggregate conversation stats from origin details when summaries omit metadata", async () => {
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
      requester: { fullName: "Later Requester" },
      sessionId: "turn-1",
      sliceId: 1,
      startedAtMs: Date.parse("2026-06-04T10:05:00.000Z"),
      state: "completed",
    });

    const stats = await createJuniorReporting().getConversationStats();

    expect(stats.requesters).toEqual([
      expect.objectContaining({
        conversations: 1,
        label: "Origin Requester",
        runs: 1,
      }),
    ]);
    expect(stats.locations).toEqual([
      expect.objectContaining({
        conversations: 1,
        label: "#proj-alpha",
        runs: 1,
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
      requester: { fullName: "Scheduler" },
      sessionId: "dispatch:scheduler",
      sliceId: 1,
      state: "completed",
      surface: "scheduler",
    });
    await recordAgentTurnSessionSummary({
      conversationId: "agent-dispatch:dispatch_api",
      cumulativeDurationMs: 1_000,
      requester: { fullName: "API" },
      sessionId: "dispatch:api",
      sliceId: 1,
      state: "completed",
      surface: "api",
    });

    const stats = await createJuniorReporting().getConversationStats();

    expect(stats.locations.map((item) => item.label)).toEqual([
      "Scheduler",
      "API",
    ]);
  });

  it("hydrates capped aggregate samples before attributing cumulative turn metrics", async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.parse("2026-06-04T10:00:00.000Z");
    vi.setSystemTime(new Date(startedAtMs));
    const { recordAgentTurnSessionSummary } =
      await import("@/chat/state/turn-session");
    const { createJuniorReporting } = await import("@/reporting");

    await recordAgentTurnSessionSummary({
      conversationId: "slack:C1:baseline",
      cumulativeDurationMs: 1_000,
      requester: { fullName: "Avery" },
      sessionId: "turn-baseline",
      sliceId: 1,
      startedAtMs,
      state: "completed",
    });
    for (let index = 0; index < 5_000; index += 1) {
      vi.setSystemTime(new Date(startedAtMs + (index + 1) * 1000));
      await recordAgentTurnSessionSummary({
        conversationId: `slack:C_FILL:${index}`,
        cumulativeDurationMs: 1,
        requester: { fullName: "Filler" },
        sessionId: `turn-${index}`,
        sliceId: 1,
        state: "completed",
      });
    }
    vi.setSystemTime(new Date(startedAtMs + 5_001 * 1000));
    await recordAgentTurnSessionSummary({
      conversationId: "slack:C1:baseline",
      cumulativeDurationMs: 1_500,
      requester: { fullName: "Blake" },
      sessionId: "turn-latest",
      sliceId: 1,
      state: "completed",
    });

    const stats = await createJuniorReporting().getConversationStats();
    const avery = stats.requesters.find((item) => item.label === "Avery");
    const blake = stats.requesters.find((item) => item.label === "Blake");

    expect(stats.truncated).toBe(true);
    expect(stats.sampleSize).toBe(5_000);
    expect(avery).toMatchObject({ durationMs: 1_000, runs: 1 });
    expect(blake).toMatchObject({ durationMs: 500, runs: 1 });
  }, 20_000);

  it("marks aggregate conversation stats truncated when the sample cap is reached", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    const { recordAgentTurnSessionSummary } =
      await import("@/chat/state/turn-session");
    const { createJuniorReporting } = await import("@/reporting");

    for (let index = 0; index < 5_001; index += 1) {
      await recordAgentTurnSessionSummary({
        conversationId: `slack:C1:${index}`,
        sessionId: `turn-${index}`,
        sliceId: 1,
        state: "completed",
      });
    }

    const stats = await createJuniorReporting().getConversationStats();

    expect(stats).toMatchObject({
      sampleLimit: 5_000,
      sampleSize: 5_000,
      truncated: true,
    });
  }, 20_000);

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
    const { recordAgentTurnSessionSummary, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { createJuniorReporting } = await import("@/reporting");

    await upsertAgentTurnSessionRecord({
      conversationId: "slack:C1:999",
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

    for (let index = 0; index < 5_005; index += 1) {
      await recordAgentTurnSessionSummary({
        conversationId: `slack:C2:${index}`,
        sessionId: `newer-turn-${index}`,
        sliceId: 1,
        state: "completed",
      });
    }

    const report =
      await createJuniorReporting().getConversation("slack:C1:999");

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
        slackUserId: "U1",
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
