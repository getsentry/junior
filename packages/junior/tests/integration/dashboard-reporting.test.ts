import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Conversation,
  ConversationStore,
} from "@/chat/conversations/store";
import { renderAdvisorRequest } from "@/chat/advisor-request";
import type { PiMessage } from "@/chat/pi/messages";

vi.mock("@/chat/prompt", () => ({
  buildSystemPrompt: vi.fn(() => "[system prompt]"),
  buildTurnContextPrompt: vi.fn(() => null),
  JUNIOR_PERSONALITY: "",
  JUNIOR_WORLD: null,
}));

const ORIGINAL_ENV = { ...process.env };
const TEST_DATABASE_URL = ORIGINAL_ENV.DATABASE_URL;

if (!TEST_DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for dashboard reporting integration tests",
  );
}

function slackActor(fullName: string, userId = "U1") {
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
    async getDestinationVisibility() {
      return undefined;
    },
    async ensureChildConversation() {},
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

/**
 * Record a source-confirmed public destination so reads may expose raw
 * content, mirroring a live event whose channel_type was "channel".
 */
async function confirmPublicSlackConversation(
  conversationId: string,
  channelId = "C1",
) {
  const { getConversationStore } = await import("@/chat/db");
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "slack", teamId: "T1", channelId },
    visibility: "public",
  });
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

  it("lists recent conversations through reporting", async () => {
    const { getConversationStore } = await import("@/chat/db");
    const { createJuniorReporting } = await import("@/reporting");
    const conversationStore = getConversationStore();

    await conversationStore.recordActivity({
      conversationId: "slack:C1:111",
      channelName: "incidents",
      destination: { platform: "slack", teamId: "T1", channelId: "C1" },
      nowMs: 1_000,
      source: "slack",
      title: "Incident follow-up",
      visibility: "public",
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

  it("redacts C-prefixed conversations Slack reports as private", async () => {
    const { getConversationStore } = await import("@/chat/db");
    const { createJuniorReporting } = await import("@/reporting");
    const conversationStore = getConversationStore();

    // Modern Slack private channels use C-prefixed ids; the event said
    // channel_type: group, so the destination is confirmed private.
    await conversationStore.recordActivity({
      conversationId: "slack:C9:333",
      channelName: "stealth-project",
      destination: { platform: "slack", teamId: "T1", channelId: "C9" },
      nowMs: 1_000,
      source: "slack",
      title: "Stealth planning",
      visibility: "private",
    });

    const summaries = await createJuniorReporting().listRecentConversations();

    expect(JSON.stringify(summaries)).not.toContain("stealth-project");
    expect(JSON.stringify(summaries)).not.toContain("Stealth planning");
    expect(summaries[0]).toMatchObject({
      conversationId: "slack:C9:333",
    });
  });

  it("redacts C-prefixed conversations without public visibility", async () => {
    const { getConversationStore } = await import("@/chat/db");
    const { createJuniorReporting } = await import("@/reporting");
    const conversationStore = getConversationStore();

    // Legacy-style row: no live signal ever marked this channel public.
    await conversationStore.recordActivity({
      conversationId: "slack:C9:444",
      channelName: "maybe-private-room",
      destination: { platform: "slack", teamId: "T1", channelId: "C9" },
      nowMs: 1_000,
      source: "slack",
      title: "Private by default",
    });

    const summaries = await createJuniorReporting().listRecentConversations();

    expect(JSON.stringify(summaries)).not.toContain("maybe-private-room");
    expect(JSON.stringify(summaries)).not.toContain("Private by default");
    expect(summaries[0]).toMatchObject({
      channelName: "Private Conversation",
      channelNameRedacted: true,
      displayTitle: "Private Conversation",
    });
  });

  it("uses SQL title and visible messages when agent steps are absent", async () => {
    const { getConversationMessageStore, getConversationStore } =
      await import("@/chat/db");
    const { createJuniorReporting } = await import("@/reporting");

    await confirmPublicSlackConversation("slack:C1:details-only");
    await getConversationStore().recordActivity({
      conversationId: "slack:C1:details-only",
      channelName: "proj-alpha",
      source: "slack",
      title: "SQL Title",
    });
    await getConversationMessageStore().record("slack:C1:details-only", [
      {
        messageId: "visible-only",
        role: "user",
        text: "Visible SQL message",
        createdAtMs: 1_000,
      },
    ]);

    const report = await createJuniorReporting().getConversation(
      "slack:C1:details-only",
    );

    expect(report).toMatchObject({
      conversationId: "slack:C1:details-only",
      displayTitle: "SQL Title",
    });
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({
      transcriptAvailable: true,
      transcriptMessageCount: 1,
      transcript: [
        {
          role: "user",
          timestamp: 1_000,
          parts: [{ type: "text", text: "Visible SQL message" }],
        },
      ],
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
        teamId: "T1",
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
        actor: slackActor("Avery"),
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
      actors: [
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

  it("reports aggregate conversation stats by actor and location", async () => {
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
          actor: { fullName: "Casey" },
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
          actor: { fullName: "Blake" },
          source: "slack",
          visibility: "public",
        }),
        indexedConversation({
          conversationId: "slack:D1:200",
          createdAtMs: Date.parse("2026-06-04T11:00:00.000Z"),
          execution: {
            status: "awaiting_resume",
            updatedAtMs: Date.parse("2026-06-04T11:02:00.000Z"),
          },
          lastActivityAtMs: Date.parse("2026-06-04T11:02:00.000Z"),
          actor: { fullName: "Avery" },
          source: "slack",
        }),
      ]),
    });

    expect(stats).toMatchObject({
      active: 1,
      conversations: 2,
      durationMs: 0,
      failed: 1,
      actors: [
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

  it("reports conversation feed from SQL metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    const { recordAgentTurnSessionSummary } =
      await import("@/chat/state/turn-session");
    const { createJuniorReporting } = await import("@/reporting");

    await recordAgentTurnSessionSummary({
      conversationId: "slack:C1:100",
      cumulativeDurationMs: 1_000,
      channelName: "proj-alpha",
      destination: { platform: "slack", teamId: "T1", channelId: "C1" },
      destinationVisibility: "public",
      actor: slackActor("Later Actor"),
      sessionId: "turn-1",
      sliceId: 1,
      startedAtMs: Date.parse("2026-06-04T10:05:00.000Z"),
      state: "completed",
    });

    const feed = await createJuniorReporting().listConversations();

    expect(
      feed.conversations.map((conversation) => conversation.actorIdentity),
    ).toEqual([
      expect.objectContaining({
        fullName: "Later Actor",
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
      actor: slackActor("Scheduler"),
      sessionId: "dispatch:scheduler",
      sliceId: 1,
      state: "completed",
      surface: "scheduler",
    });
    await recordAgentTurnSessionSummary({
      conversationId: "agent-dispatch:dispatch_api",
      cumulativeDurationMs: 1_000,
      actor: slackActor("API"),
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
      actor: slackActor("Avery"),
      sessionId: "turn-failed",
      sliceId: 1,
      state: "failed",
      surface: "slack",
    });

    const stats = await createJuniorReporting().getConversationStats();

    expect(stats).toMatchObject({
      failed: 1,
      runs: 1,
      actors: [
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
        actor: { fullName: "Blake" },
        source: "slack",
      }),
      ...Array.from({ length: 5_000 }, (_, index) =>
        indexedConversation({
          conversationId: `slack:C0FILL:${index}`,
          createdAtMs: startedAtMs + (index + 1) * 1000,
          lastActivityAtMs: startedAtMs + (index + 1) * 1000,
          actor: { fullName: "Filler" },
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

  it("reports the complete SQL conversation transcript", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { createJuniorReporting } = await import("@/reporting");

    await confirmPublicSlackConversation("slack:C1:222");
    await upsertAgentTurnSessionRecord({
      conversationId: "slack:C1:222",
      sessionId: "turn-current",
      sliceId: 1,
      state: "completed",
      modelId: "openai/gpt-5.5",
      reasoningLevel: "high",
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
          content: [
            {
              type: "text",
              text: [
                "<thread-background>",
                "prior context",
                "</thread-background>",
                "",
                "<current-instruction>",
                "current question",
                "</current-instruction>",
              ].join("\n"),
            },
          ],
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
      modelId: "openai/gpt-5.5",
      reasoningLevel: "high",
      transcriptMessageCount: 4,
    });
    expect(report.runs[0]!.transcript).toEqual([
      {
        role: "user",
        timestamp: 1,
        parts: [{ type: "text", text: "previous question" }],
      },
      {
        role: "assistant",
        timestamp: 2,
        parts: [{ type: "text", text: "previous answer" }],
      },
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

  it("omits execution settings when the current run has no matching summary", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { readConversationReport } =
      await import("@/reporting/conversations");
    const conversationId = "internal:missing-current-summary";

    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: "turn-older",
      sliceId: 1,
      state: "completed",
      modelId: "openai/gpt-4.1",
      reasoningLevel: "low",
      piMessages: [],
    });

    const report = await readConversationReport(conversationId, {
      conversationStore: fixedConversationStore([
        indexedConversation({
          conversationId,
          createdAtMs: 1,
          lastActivityAtMs: 2,
          execution: {
            runId: "turn-current",
            status: "running",
            updatedAtMs: 2,
          },
        }),
      ]),
    });

    expect(report.runs[0]).not.toHaveProperty("modelId");
    expect(report.runs[0]).not.toHaveProperty("reasoningLevel");
  });

  it("reports private execution activity as safe metadata", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { getAgentStepStore } = await import("@/chat/db");
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
    // Activity now derives from durable agent steps, not the Redis session log.
    await getAgentStepStore().append("slack:G1:activity", [
      {
        entry: {
          type: "tool_execution_started",
          toolCallId: "advisor-call-1",
          toolName: "advisor",
          args: { question: "private question", context: "private context" },
        },
        createdAtMs: 2,
      },
      {
        entry: {
          type: "subagent_started",
          subagentInvocationId: "advisor-call-1",
          subagentKind: "advisor",
          parentToolCallId: "advisor-call-1",
          childConversationId: "advisor:slack:G1:activity",
          historyMode: "shared",
          modelId: "openai/gpt-5.6-sol",
          reasoningLevel: "high",
        },
        createdAtMs: 3,
      },
      {
        entry: {
          type: "subagent_ended",
          subagentInvocationId: "advisor-call-1",
          outcome: "success",
        },
        createdAtMs: 5,
      },
    ]);

    const report =
      await createJuniorReporting().getConversation("slack:G1:activity");

    expect(report.runs[0]?.activity).toEqual([
      expect.objectContaining({
        type: "tool_execution",
        toolCallId: "advisor-call-1",
        toolName: "advisor",
        status: "completed",
        redacted: true,
        // jsonb round-trips object keys in length-then-byte order.
        inputKeys: ["context", "question"],
        subagents: [
          expect.objectContaining({
            type: "subagent",
            id: "advisor-call-1",
            outcome: "success",
            parentToolCallId: "advisor-call-1",
            modelId: "openai/gpt-5.6-sol",
            reasoningLevel: "high",
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

  it("loads advisor subagent transcript history from the child conversation", async () => {
    const { advisorChildConversationId } =
      await import("@/chat/tools/advisor/tool");
    const { getAgentStepStore, getConversationStore } =
      await import("@/chat/db");
    const { createJuniorReporting } = await import("@/reporting");

    const conversationId = "slack:C1:advisor-slices";
    const runId = "turn-advisor-slices";
    await confirmPublicSlackConversation(conversationId);
    const childConversationId = advisorChildConversationId(conversationId);
    const conversationStore = getConversationStore();
    const stepStore = getAgentStepStore();

    await conversationStore.ensureChildConversation({
      conversationId: childConversationId,
      parentConversationId: conversationId,
    });
    await stepStore.append(childConversationId, [
      {
        entry: {
          type: "pi_message",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: renderAdvisorRequest(
                  "first advisor question",
                  "first <evidence> packet",
                ),
              },
            ],
            timestamp: 10,
          } as PiMessage,
        },
        createdAtMs: 10,
      },
      {
        entry: {
          type: "pi_message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "first advisor answer" }],
            timestamp: 20,
          } as PiMessage,
        },
        createdAtMs: 20,
      },
      {
        entry: {
          type: "pi_message",
          message: {
            role: "user",
            content: [{ type: "text", text: "second advisor question" }],
            timestamp: 30,
          } as PiMessage,
        },
        createdAtMs: 30,
      },
      {
        entry: {
          type: "pi_message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "second advisor answer" }],
            timestamp: 40,
          } as PiMessage,
        },
        createdAtMs: 40,
      },
    ]);

    // Repeated advisor calls share one deterministic child conversation, so both
    // parent subagent markers name the same child history.
    for (const subagentId of ["advisor-plan", "advisor-review"]) {
      await stepStore.append(conversationId, [
        {
          entry: {
            type: "subagent_started",
            subagentInvocationId: subagentId,
            subagentKind: "advisor",
            parentToolCallId: subagentId,
            childConversationId,
            historyMode: "shared",
            modelId: "openai/gpt-5.6-sol",
            reasoningLevel: "high",
          },
          createdAtMs: subagentId === "advisor-plan" ? 3 : 31,
        },
        {
          entry: {
            type: "subagent_ended",
            subagentInvocationId: subagentId,
            outcome: "success",
          },
          createdAtMs: subagentId === "advisor-plan" ? 25 : 45,
        },
      ]);
    }

    const reporting = createJuniorReporting();
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

    expect(first.subagentConversationId).toBe(childConversationId);
    expect(first.modelId).toBe("openai/gpt-5.6-sol");
    expect(first.reasoningLevel).toBe("high");
    expect(first.transcriptAvailable).toBe(true);
    expect(JSON.stringify(first.transcript)).toContain(
      "first advisor question",
    );
    expect(JSON.stringify(first.transcript)).toContain(
      "first <evidence> packet",
    );
    expect(JSON.stringify(first.transcript)).not.toContain("<advisor-task>");
    expect(JSON.stringify(first.transcript)).not.toContain(
      "<executor-context>",
    );
    expect(JSON.stringify(first.transcript)).toContain("second advisor answer");
    expect(second.subagentConversationId).toBe(childConversationId);
    expect(JSON.stringify(second.transcript)).toContain("first advisor answer");
  });

  it("redacts advisor subagent transcript history for private conversations", async () => {
    const { advisorChildConversationId } =
      await import("@/chat/tools/advisor/tool");
    const { getAgentStepStore, getConversationStore } =
      await import("@/chat/db");
    const { createJuniorReporting } = await import("@/reporting");

    const conversationId = "slack:D1:advisor-private";
    const runId = "turn-advisor-private";
    const toolCallId = "advisor-private";
    const privateAdvisorText = "private advisor question";
    const childConversationId = advisorChildConversationId(conversationId);
    const conversationStore = getConversationStore();
    const stepStore = getAgentStepStore();

    await conversationStore.ensureChildConversation({
      conversationId: childConversationId,
      parentConversationId: conversationId,
    });
    await stepStore.append(childConversationId, [
      {
        entry: {
          type: "pi_message",
          message: {
            role: "user",
            content: [{ type: "text", text: privateAdvisorText }],
            timestamp: 10,
          } as PiMessage,
        },
        createdAtMs: 10,
      },
    ]);
    await stepStore.append(conversationId, [
      {
        entry: {
          type: "subagent_started",
          subagentInvocationId: toolCallId,
          subagentKind: "advisor",
          parentToolCallId: toolCallId,
          childConversationId,
          historyMode: "shared",
        },
        createdAtMs: 3,
      },
      {
        entry: {
          type: "subagent_ended",
          subagentInvocationId: toolCallId,
          outcome: "success",
        },
        createdAtMs: 10,
      },
    ]);

    const reporting = createJuniorReporting();
    const transcript = await reporting.getConversationSubagentTranscript(
      conversationId,
      runId,
      toolCallId,
    );

    expect(transcript.subagentConversationId).toBe(childConversationId);
    expect(transcript.transcriptAvailable).toBe(false);
    expect(transcript.transcriptRedacted).toBe(true);
    expect(transcript.transcript).toEqual([]);
    expect(JSON.stringify(transcript)).not.toContain(privateAdvisorText);
  });

  it("derives unfinished subagent status from completed parent tool results", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { getAgentStepStore } = await import("@/chat/db");
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
    // The subagent has no end step; its status derives from the parent tool's
    // completed result in the current epoch projection.
    await getAgentStepStore().append("slack:C1:activity-parent-result", [
      {
        entry: {
          type: "tool_execution_started",
          toolCallId: "advisor-call-parent",
          toolName: "advisor",
          args: { question: "public question" },
        },
        createdAtMs: 2,
      },
      {
        entry: {
          type: "subagent_started",
          subagentInvocationId: "advisor-call-parent",
          subagentKind: "advisor",
          parentToolCallId: "advisor-call-parent",
          childConversationId: "advisor:slack:C1:activity-parent-result",
          historyMode: "shared",
        },
        createdAtMs: 3,
      },
    ]);

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

  it("keeps the complete SQL transcript when steering adds a message", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { createJuniorReporting } = await import("@/reporting");

    await confirmPublicSlackConversation("slack:C1:steering-transcript");
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
      transcriptMessageCount: 6,
    });
    expect(report.runs[0]!.transcript).toEqual([
      {
        role: "user",
        timestamp: 1,
        parts: [{ type: "text", text: "previous question" }],
      },
      {
        role: "assistant",
        timestamp: 2,
        parts: [{ type: "text", text: "previous answer" }],
      },
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

  it("reports a conversation directly from SQL without a turn index", async () => {
    const { getAgentStepStore, getConversationStore } =
      await import("@/chat/db");
    const { readConversationReport } =
      await import("@/reporting/conversations");
    await getConversationStore().recordActivity({
      conversationId: "slack:C1:999",
      destination: {
        platform: "slack",
        teamId: "T1",
        channelId: "C1",
      },
      source: "slack",
      visibility: "public",
    });
    await getAgentStepStore().append("slack:C1:999", [
      {
        entry: {
          type: "pi_message",
          message: {
            role: "user",
            content: [{ type: "text", text: "target question" }],
            timestamp: 1,
          } as PiMessage,
        },
        createdAtMs: 1,
      },
    ]);

    const report = await readConversationReport("slack:C1:999");

    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({
      id: "slack:C1:999",
      transcriptAvailable: true,
    });
    expect(report.runs[0]!.transcript).toEqual([
      {
        role: "user",
        timestamp: 1,
        parts: [{ type: "text", text: "target question" }],
      },
    ]);
  });

  it("reports multiple turns as one complete SQL transcript", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { createJuniorReporting } = await import("@/reporting");

    await confirmPublicSlackConversation("slack:C1:333");
    await upsertAgentTurnSessionRecord({
      conversationId: "slack:C1:333",
      destination: {
        platform: "slack",
        teamId: "T1",
        channelId: "C1",
      },
      source: {
        platform: "slack",
        type: "pub",
        teamId: "T1",
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
        teamId: "T1",
        channelId: "C1",
      },
      source: {
        platform: "slack",
        type: "pub",
        teamId: "T1",
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

    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({ id: "slack:C1:333" });
    expect(report.runs[0]!.transcript).toEqual([
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
      actor: {
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
      channelNameRedacted: true,
      id: "slack:D1:222",
      actorIdentity: {
        email: "david@sentry.io",
        slackUserId: "U1",
      },
      transcriptAvailable: false,
      transcriptMessageCount: 2,
      transcriptRedacted: true,
      transcriptRedactionReason: "non_public_conversation",
      transcript: [],
    });
    expect(report.runs[0]).not.toHaveProperty("actor");
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
      channelNameRedacted: true,
      id: "slack:D1:333",
      transcriptAvailable: false,
      transcriptMetadata: [],
      transcriptRedacted: true,
      transcriptRedactionReason: "non_public_conversation",
      transcript: [],
    });
  });

  it("presents purged conversation content as expired under retention", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { getSqlExecutor } = await import("@/chat/db");
    const { purgeConversation } =
      await import("@/chat/conversations/retention");
    const { createJuniorReporting } = await import("@/reporting");

    const conversationId = "slack:C1:purged";
    await confirmPublicSlackConversation(conversationId);
    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: "turn-purged",
      sliceId: 1,
      state: "completed",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "public question" }],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "public answer" }],
          timestamp: 2,
        },
      ] as PiMessage[],
    });

    // Retention deletes content wholesale and stamps transcript_purged_at.
    await purgeConversation(getSqlExecutor(), conversationId, {
      nowMs: Date.now(),
    });

    const report =
      await createJuniorReporting().getConversation(conversationId);

    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({
      id: "slack:C1:purged",
      transcriptAvailable: false,
      transcriptExpired: true,
      transcriptMetadata: [],
      transcript: [],
    });
    // Expiry under retention is distinct from privacy redaction, even though
    // this conversation is public.
    expect(report.runs[0]).not.toHaveProperty("transcriptRedacted");
    expect(report.runs[0]?.transcriptExpiredAt).toEqual(expect.any(String));
    expect(JSON.stringify(report)).not.toContain("public question");
    expect(JSON.stringify(report)).not.toContain("public answer");
  });

  it("reports only current-epoch activity after a compaction rebuild", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { getAgentStepStore } = await import("@/chat/db");
    const { createJuniorReporting } = await import("@/reporting");

    const conversationId = "slack:C1:compaction";
    await confirmPublicSlackConversation(conversationId);
    const stepStore = getAgentStepStore();

    // Epoch 0: a tool execution a later compaction supersedes (audit history).
    await stepStore.append(conversationId, [
      {
        entry: {
          type: "pi_message",
          message: {
            role: "user",
            content: [{ type: "text", text: "old question" }],
            timestamp: 1,
          } as PiMessage,
        },
        createdAtMs: 1,
      },
      {
        entry: {
          type: "tool_execution_started",
          toolCallId: "old-tool",
          toolName: "search",
        },
        createdAtMs: 2,
      },
    ]);
    // Compaction opens epoch 1 with the rebuilt context.
    await stepStore.startEpoch(conversationId, {
      reason: "compaction",
      messages: [
        {
          message: {
            role: "user",
            content: [{ type: "text", text: "current question" }],
            timestamp: 3,
          } as PiMessage,
          createdAtMs: 3,
        },
      ],
    });
    // A turn-session record pinned to the current epoch drives the run; the
    // identical prompt commits no new rows.
    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: "turn-compacted",
      sliceId: 1,
      state: "completed",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "current question" }],
          timestamp: 3,
        },
      ] as PiMessage[],
    });
    // A current-epoch tool execution the report should surface.
    await stepStore.append(conversationId, [
      {
        entry: {
          type: "tool_execution_started",
          toolCallId: "new-tool",
          toolName: "search",
          args: { q: "current question" },
        },
        createdAtMs: 4,
      },
    ]);

    const report =
      await createJuniorReporting().getConversation(conversationId);
    const currentRun = report.runs.at(-1);
    const toolIds = (currentRun?.activity ?? [])
      .filter((row) => row.type === "tool_execution")
      .map((row) => row.toolCallId);

    expect(toolIds).toEqual(["new-tool"]);
    expect(JSON.stringify(currentRun?.transcript)).toContain(
      "current question",
    );
    expect(JSON.stringify(currentRun?.transcript)).not.toContain(
      "old question",
    );
  });
});
