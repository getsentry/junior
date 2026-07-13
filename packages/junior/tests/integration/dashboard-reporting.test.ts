import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import { readConversationDetail } from "@/api/conversations/detail";
import { readConversationSubagent as readConversationSubagentTranscriptReport } from "@/api/conversations/subagent";

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

async function readConversationDetailReport(conversationId: string) {
  const report = await readConversationDetail(conversationId);
  if (!report) throw new Error(`Missing SQL conversation ${conversationId}`);
  return report;
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
      modelId: "test/model",
      conversationId: "slack:C1:111",
      sessionId: "turn-1",
      sliceId: 1,
      state: "running",
      piMessages: [],
    });
    await upsertAgentTurnSessionRecord({
      modelId: "test/model",
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
      modelId: "test/model",
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

  it("lists recent conversations for plugin operational reports", async () => {
    const { getConversationStore } = await import("@/chat/db");
    const { listRecentConversationSummaries } =
      await import("@/reporting/plugin-conversations");
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

    await expect(listRecentConversationSummaries()).resolves.toEqual([
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
    const { listRecentConversationSummaries } =
      await import("@/reporting/plugin-conversations");
    const conversationStore = getConversationStore();

    await conversationStore.recordActivity({
      conversationId: "slack:G1:222",
      channelName: "private-incident-room",
      nowMs: 1_000,
      source: "slack",
      title: "Sensitive escalation",
    });

    const summaries = await listRecentConversationSummaries();

    expect(JSON.stringify(summaries)).not.toContain("private-incident-room");
    expect(JSON.stringify(summaries)).not.toContain("Sensitive escalation");
    expect(summaries[0]).toMatchObject({
      conversationId: "slack:G1:222",
      status: "completed",
    });
  });

  it("redacts C-prefixed conversations Slack reports as private", async () => {
    const { getConversationStore } = await import("@/chat/db");
    const { listRecentConversationSummaries } =
      await import("@/reporting/plugin-conversations");
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

    const summaries = await listRecentConversationSummaries();

    expect(JSON.stringify(summaries)).not.toContain("stealth-project");
    expect(JSON.stringify(summaries)).not.toContain("Stealth planning");
    expect(summaries[0]).toMatchObject({
      conversationId: "slack:C9:333",
    });
  });

  it("redacts C-prefixed conversations without public visibility", async () => {
    const { getConversationStore } = await import("@/chat/db");
    const { listRecentConversationSummaries } =
      await import("@/reporting/plugin-conversations");
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

    const summaries = await listRecentConversationSummaries();

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

    const report = await readConversationDetailReport("slack:C1:details-only");

    expect(report).toMatchObject({
      conversationId: "slack:C1:details-only",
      displayTitle: "SQL Title",
    });
    expect(report).toMatchObject({
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

  it("reports conversation-index detail when conversation records are absent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    const { requestConversationWork } =
      await import("@/chat/task-execution/store");

    await requestConversationWork({
      conversationId: "slack:C1:index-only",
      destination: {
        platform: "slack",
        teamId: "T1",
        channelId: "C1",
      },
      nowMs: Date.now(),
    });

    const report = await readConversationDetailReport("slack:C1:index-only");

    expect(report).toMatchObject({
      conversationId: "slack:C1:index-only",
      status: "active",
      transcriptAvailable: false,
      transcript: [],
    });
  });

  it("reports the complete SQL conversation transcript", async () => {
    const { recordAgentTurnSessionSummary, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { readConversationDetailFromSql } =
      await import("@/api/conversations/detail.query");

    await confirmPublicSlackConversation("slack:C1:222");
    await upsertAgentTurnSessionRecord({
      conversationId: "slack:C1:222",
      sessionId: "turn-current",
      sliceId: 1,
      state: "completed",
      cumulativeDurationMs: 1_200,
      cumulativeUsage: { inputTokens: 100, outputTokens: 20 },
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
            { type: "thinking", thinking: "I should use a tool" },
            { type: "thinking", thinking: "" },
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
    await recordAgentTurnSessionSummary({
      conversationId: "slack:C1:222",
      sessionId: "turn-running",
      sliceId: 1,
      state: "running",
    });

    const report = await readConversationDetailFromSql("slack:C1:222");
    expect(report).toMatchObject({
      cumulativeDurationMs: 1_200,
      cumulativeUsage: { totalTokens: 120 },
      modelId: "openai/gpt-5.5",
      reasoningLevel: "high",
      transcriptMessageCount: 4,
    });
    expect(report?.transcript).toEqual([
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

  it("reports private execution activity as safe metadata", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { getAgentStepStore } = await import("@/chat/db");

    await upsertAgentTurnSessionRecord({
      modelId: "test/model",
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
    await getAgentStepStore().startEpoch("slack:G1:activity", {
      reason: "compaction",
      modelProfile: "standard",
      modelId: "test/model",
      messages: [
        {
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "Context compaction summary for future Junior turns:\nprivate incident details",
              },
            ],
            timestamp: 6,
          } as PiMessage,
          createdAtMs: 6,
        },
      ],
    });

    const report = await readConversationDetailReport("slack:G1:activity");

    expect(report.activity).toEqual([
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
    expect(report.contextEvents).toEqual([
      expect.objectContaining({
        type: "context_compacted",
        modelId: "test/model",
      }),
    ]);
    expect(report.contextEvents?.[0]).not.toHaveProperty("summary");
    expect(JSON.stringify(report.activity)).not.toContain("private question");
    expect(JSON.stringify(report)).not.toContain("private incident details");
  });

  it("loads subagent transcript history from the child conversation", async () => {
    const { getAgentStepStore, getConversationStore } =
      await import("@/chat/db");

    const conversationId = "slack:C1:subagent-slices";
    await confirmPublicSlackConversation(conversationId);
    const childConversationId = `task:${conversationId}`;
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
                text: "first subagent question\n\nExecutor context:\nfirst <evidence> packet",
              },
            ],
            timestamp: 10,
          } as PiMessage,
          provenance: { authority: "instruction" },
        },
        createdAtMs: 10,
      },
      {
        entry: {
          type: "pi_message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "first subagent answer" }],
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
            content: [{ type: "text", text: "second subagent question" }],
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
            content: [{ type: "text", text: "second subagent answer" }],
            timestamp: 40,
          } as PiMessage,
        },
        createdAtMs: 40,
      },
      {
        entry: {
          type: "pi_message",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "<advisor-task>\nReview &lt;change&gt;.\n</advisor-task>\n\n" +
                  "<executor-context>\nUse A &amp; B.\n</executor-context>",
              },
            ],
            timestamp: 50,
          } as PiMessage,
        },
        createdAtMs: 50,
      },
    ]);

    // Repeated subagent calls share one child conversation, so both
    // parent subagent markers name the same child history.
    for (const subagentId of ["task-plan", "task-review"]) {
      await stepStore.append(conversationId, [
        {
          entry: {
            type: "subagent_started",
            subagentInvocationId: subagentId,
            subagentKind: "task",
            parentToolCallId: subagentId,
            childConversationId,
            historyMode: "shared",
            modelId: "openai/gpt-5.6-sol",
            reasoningLevel: "high",
          },
          createdAtMs: subagentId === "task-plan" ? 3 : 31,
        },
        {
          entry: {
            type: "subagent_ended",
            subagentInvocationId: subagentId,
            outcome: "success",
          },
          createdAtMs: subagentId === "task-plan" ? 25 : 45,
        },
      ]);
    }
    await stepStore.append(conversationId, [
      {
        entry: {
          type: "subagent_started",
          subagentInvocationId: "legacy-advisor",
          subagentKind: "advisor",
          childConversationId,
          historyMode: "shared",
        },
        createdAtMs: 50,
      },
      {
        entry: {
          type: "subagent_ended",
          subagentInvocationId: "legacy-advisor",
          outcome: "success",
        },
        createdAtMs: 55,
      },
    ]);

    const first = await readConversationSubagentTranscriptReport(
      conversationId,
      "task-plan",
    );
    const second = await readConversationSubagentTranscriptReport(
      conversationId,
      "task-review",
    );
    const legacyAdvisor = await readConversationSubagentTranscriptReport(
      conversationId,
      "legacy-advisor",
    );

    expect(first.subagentConversationId).toBe(childConversationId);
    expect(first.modelId).toBe("openai/gpt-5.6-sol");
    expect(first.reasoningLevel).toBe("high");
    expect(first.transcriptAvailable).toBe(true);
    expect(JSON.stringify(first.transcript)).toContain(
      "first subagent question",
    );
    expect(JSON.stringify(first.transcript)).toContain(
      "first <evidence> packet",
    );
    expect(JSON.stringify(first.transcript)).toContain(
      "second subagent answer",
    );
    expect(second.subagentConversationId).toBe(childConversationId);
    expect(JSON.stringify(second.transcript)).toContain(
      "first subagent answer",
    );
    expect(first.transcript.at(-1)?.parts[0]).toEqual({
      type: "text",
      text:
        "<advisor-task>\nReview &lt;change&gt;.\n</advisor-task>\n\n" +
        "<executor-context>\nUse A &amp; B.\n</executor-context>",
    });
    expect(legacyAdvisor.transcript.at(-1)?.parts[0]).toEqual({
      type: "text",
      text: "Review <change>.\n\nExecutor context:\nUse A & B.",
    });
  });

  it("redacts advisor subagent transcript history for private conversations", async () => {
    const { getAgentStepStore, getConversationStore } =
      await import("@/chat/db");

    const conversationId = "slack:D1:advisor-private";
    const toolCallId = "advisor-private";
    const privateAdvisorText = "private advisor question";
    const childConversationId = `advisor:${conversationId}`;
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

    const transcript = await readConversationSubagentTranscriptReport(
      conversationId,
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

    await upsertAgentTurnSessionRecord({
      modelId: "test/model",
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

    const report = await readConversationDetailReport(
      "slack:C1:activity-parent-result",
    );

    expect(report.activity).toEqual([
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

    await confirmPublicSlackConversation("slack:C1:steering-transcript");
    await upsertAgentTurnSessionRecord({
      modelId: "test/model",
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

    const report = await readConversationDetailReport(
      "slack:C1:steering-transcript",
    );
    expect(report).toMatchObject({
      transcriptMessageCount: 6,
    });
    expect(report.transcript).toEqual([
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

  it("reports a conversation directly from SQL without a secondary execution index", async () => {
    const { getAgentStepStore, getConversationStore } =
      await import("@/chat/db");
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

    const report = await readConversationDetailReport("slack:C1:999");
    expect(report).toMatchObject({
      conversationId: "slack:C1:999",
      transcriptAvailable: true,
    });
    expect(report.transcript).toEqual([
      {
        role: "user",
        timestamp: 1,
        parts: [{ type: "text", text: "target question" }],
      },
    ]);
  });

  it("keeps SQL detail available when optional execution settings fail", async () => {
    const { getAgentStepStore, getConversationStore } =
      await import("@/chat/db");
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const conversationId = "slack:C1:settings-unavailable";
    await getConversationStore().recordActivity({
      conversationId,
      destination: {
        platform: "slack",
        teamId: "T1",
        channelId: "C1",
      },
      source: "slack",
      visibility: "public",
    });
    await getAgentStepStore().append(conversationId, [
      {
        entry: {
          type: "pi_message",
          message: {
            role: "user",
            content: [{ type: "text", text: "available transcript" }],
            timestamp: 1,
          } as PiMessage,
        },
        createdAtMs: 1,
      },
    ]);
    vi.spyOn(getStateAdapter(), "getList").mockRejectedValueOnce(
      new Error("execution settings unavailable"),
    );

    const report = await readConversationDetailReport(conversationId);

    expect(report).toMatchObject({
      conversationId,
      transcriptAvailable: true,
      transcript: [
        {
          role: "user",
          timestamp: 1,
          parts: [{ type: "text", text: "available transcript" }],
        },
      ],
    });
    expect(report).not.toHaveProperty("modelId");
    expect(report).not.toHaveProperty("reasoningLevel");
  });

  it("reports multiple message exchanges as one complete SQL transcript", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    await confirmPublicSlackConversation("slack:C1:333");
    await upsertAgentTurnSessionRecord({
      modelId: "test/model",
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
      modelId: "test/model",
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

    const report = await readConversationDetailReport("slack:C1:333");
    expect(report).toMatchObject({ conversationId: "slack:C1:333" });
    expect(report.transcript).toEqual([
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
      modelId: "test/model",
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

    const report = await readConversationDetailReport("slack:D1:222");

    expect(report).toMatchObject({
      displayTitle: "Direct Message",
      channelName: "Direct Message",
      channelNameRedacted: true,
      conversationId: "slack:D1:222",
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
    expect(report).not.toHaveProperty("actor");
    expect(JSON.stringify(report)).not.toContain("private question");
    expect(JSON.stringify(report)).not.toContain("private answer");
    expect(JSON.stringify(report)).not.toContain("private value");
    expect(JSON.stringify(report)).not.toContain(
      "sensitive generated thread title",
    );
    expect(JSON.stringify(report)).not.toContain("secret-dm-name");
    const toolCall = report.transcriptMetadata?.[1]?.parts.find(
      (part) => part.type === "tool_call",
    );
    expect(toolCall?.inputKeys).toHaveLength(20);
    expect(toolCall?.inputKeys).toContain("privateKey0");
    expect(toolCall?.inputKeys).not.toContain("privateKey20");
  });

  it("marks expired private transcripts as privacy redacted", async () => {
    const { recordAgentTurnSessionSummary } =
      await import("@/chat/state/turn-session");

    await recordAgentTurnSessionSummary({
      conversationId: "slack:D1:333",
      sessionId: "turn-private-expired",
      sliceId: 1,
      state: "completed",
    });

    const report = await readConversationDetailReport("slack:D1:333");

    expect(report).toMatchObject({
      displayTitle: "Direct Message",
      channelName: "Direct Message",
      channelNameRedacted: true,
      conversationId: "slack:D1:333",
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

    const conversationId = "slack:C1:purged";
    await confirmPublicSlackConversation(conversationId);
    await upsertAgentTurnSessionRecord({
      modelId: "test/model",
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

    const report = await readConversationDetailReport(conversationId);
    expect(report).toMatchObject({
      conversationId,
      transcriptAvailable: false,
      transcriptExpired: true,
      transcriptMetadata: [],
      transcript: [],
    });
    // Expiry under retention is distinct from privacy redaction, even though
    // this conversation is public.
    expect(report).not.toHaveProperty("transcriptRedacted");
    expect(report.transcriptExpiredAt).toEqual(expect.any(String));
    expect(JSON.stringify(report)).not.toContain("public question");
    expect(JSON.stringify(report)).not.toContain("public answer");
  });

  it("reports complete history around a compaction without copied messages", async () => {
    const { getAgentStepStore } = await import("@/chat/db");

    const conversationId = "slack:C1:compaction";
    await confirmPublicSlackConversation(conversationId);
    const stepStore = getAgentStepStore();

    // Epoch 0: execution that remains visible after a later context rebuild.
    await stepStore.append(conversationId, [
      {
        entry: {
          type: "pi_message",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "Context compaction summary for future Junior turns:\nThis is quoted documentation, not a generated summary.",
              },
            ],
            timestamp: 0,
          } as PiMessage,
        },
        createdAtMs: 0,
      },
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
          type: "pi_message",
          message: {
            role: "user",
            content: [{ type: "text", text: "current question" }],
            timestamp: 2,
          } as PiMessage,
          provenance: { authority: "instruction" },
        },
        createdAtMs: 2,
      },
      {
        entry: {
          type: "pi_message",
          message: {
            role: "user",
            content: [{ type: "text", text: "current question" }],
            timestamp: 2,
          } as PiMessage,
          provenance: { authority: "instruction" },
        },
        createdAtMs: 2,
      },
      {
        entry: {
          type: "tool_execution_started",
          toolCallId: "old-tool",
          toolName: "search",
        },
        createdAtMs: 3,
      },
    ]);
    // Compaction copies the latest user intent and adds a generated summary.
    await stepStore.startEpoch(conversationId, {
      modelId: "test/model",
      reason: "compaction",
      modelProfile: "standard",
      messages: [
        {
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "Context compaction summary for future Junior turns:\nThis is quoted documentation, not a generated summary.",
              },
            ],
            timestamp: 0,
          } as PiMessage,
          provenance: { authority: "instruction" },
          createdAtMs: 0,
        },
        {
          message: {
            role: "user",
            content: [{ type: "text", text: "current question" }],
            timestamp: 2,
          } as PiMessage,
          provenance: { authority: "instruction" },
          createdAtMs: 2,
        },
        {
          message: {
            role: "user",
            content: [{ type: "text", text: "current question" }],
            timestamp: 2,
          } as PiMessage,
          provenance: { authority: "instruction" },
          createdAtMs: 2,
        },
        {
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "Context compaction summary for future Junior turns:\nThe earlier search found the relevant deployment.",
              },
            ],
            timestamp: 4,
          } as PiMessage,
          provenance: { authority: "context" },
          createdAtMs: 4,
        },
      ],
    });
    // A current-epoch tool execution the report should surface.
    await stepStore.append(conversationId, [
      {
        entry: {
          type: "pi_message",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "Context compaction summary for future Junior turns:\nPlease explain this marker to the user.",
              },
            ],
            timestamp: 4.5,
          } as PiMessage,
          provenance: { authority: "instruction" },
        },
        createdAtMs: 4.5,
      },
      {
        entry: {
          type: "tool_execution_started",
          toolCallId: "new-tool",
          toolName: "search",
          args: { q: "current question" },
        },
        createdAtMs: 5,
      },
    ]);

    const report = await readConversationDetailReport(conversationId);
    const currentRun = report;
    const toolIds = (currentRun?.activity ?? [])
      .filter((row) => row.type === "tool_execution")
      .map((row) => row.toolCallId);

    expect(toolIds).toEqual(["old-tool", "new-tool"]);
    expect(currentRun.contextEvents).toEqual([
      expect.objectContaining({
        type: "context_compacted",
        modelId: "test/model",
        summary: "The earlier search found the relevant deployment.",
      }),
    ]);
    expect(JSON.stringify(currentRun.transcript)).toContain("old question");
    expect(JSON.stringify(currentRun.transcript)).toContain("current question");
    expect(JSON.stringify(currentRun.transcript)).toContain(
      "This is quoted documentation, not a generated summary.",
    );
    expect(JSON.stringify(currentRun.transcript)).toContain(
      "Please explain this marker to the user.",
    );
    expect(JSON.stringify(currentRun.transcript)).not.toContain(
      "The earlier search found the relevant deployment.",
    );
    expect(
      currentRun.transcript.filter((message) =>
        JSON.stringify(message).includes("current question"),
      ),
    ).toHaveLength(2);
  });

  it("reports the original execution and continuation around a model handoff", async () => {
    const { getAgentStepStore } = await import("@/chat/db");
    const conversationId = "slack:C1:handoff-reporting";
    await confirmPublicSlackConversation(conversationId);
    const stepStore = getAgentStepStore();

    await stepStore.startEpoch(conversationId, {
      reason: "initial",
      modelProfile: "standard",
      modelId: "openai/gpt-5.4",
      messages: [
        {
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "Model handoff checkpoint. Continue the outstanding request now using this summary as the complete prior context:\nThis is quoted documentation, not a generated checkpoint.",
              },
            ],
            timestamp: 0,
          } as PiMessage,
          createdAtMs: 0,
        },
        {
          message: {
            role: "user",
            content: [{ type: "text", text: "Investigate the release" }],
            timestamp: 1,
          } as PiMessage,
          createdAtMs: 1,
        },
        {
          message: {
            role: "user",
            content: [{ type: "text", text: "Investigate the release" }],
            timestamp: 1,
          } as PiMessage,
          createdAtMs: 1,
        },
        {
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "handoff-call",
                name: "handoff",
                arguments: { profile: "handoff" },
              },
            ],
            timestamp: 2,
          } as unknown as PiMessage,
          createdAtMs: 2,
        },
      ],
    });
    await stepStore.startEpoch(conversationId, {
      reason: "handoff",
      modelProfile: "handoff",
      modelId: "openai/gpt-5.6-sol",
      messages: [
        {
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "Model handoff checkpoint. Continue the outstanding request now using this summary as the complete prior context:\nThe release migration fails because its constraint is created too late.",
              },
            ],
            timestamp: 3,
          } as PiMessage,
          createdAtMs: 3,
        },
        {
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "<runtime-turn-context>\nBootstrap metadata\n</runtime-turn-context>",
              },
            ],
            timestamp: 3,
          } as PiMessage,
          createdAtMs: 3,
        },
      ],
    });
    await stepStore.append(conversationId, [
      {
        entry: {
          type: "pi_message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I prepared the ordering fix." }],
            timestamp: 4,
          } as PiMessage,
        },
        createdAtMs: 4,
      },
    ]);

    const report = await readConversationDetailReport(conversationId);

    expect(report.contextEvents).toEqual([
      expect.objectContaining({
        type: "model_handoff",
        fromModelId: "openai/gpt-5.4",
        toModelId: "openai/gpt-5.6-sol",
        message:
          "Model handoff checkpoint. Continue the outstanding request now using this summary as the complete prior context:\nThe release migration fails because its constraint is created too late.",
      }),
    ]);
    expect(JSON.stringify(report.transcript)).toContain(
      "Investigate the release",
    );
    expect(JSON.stringify(report.transcript)).toContain(
      "This is quoted documentation, not a generated checkpoint.",
    );
    expect(
      report.transcript.filter((message) =>
        JSON.stringify(message).includes("Investigate the release"),
      ),
    ).toHaveLength(2);
    expect(JSON.stringify(report.transcript)).toContain("handoff-call");
    expect(JSON.stringify(report.transcript)).toContain(
      "I prepared the ordering fix.",
    );
    expect(JSON.stringify(report.transcript)).not.toContain(
      "The release migration fails because its constraint is created too late.",
    );
    expect(JSON.stringify(report.transcript)).not.toContain(
      "runtime-turn-context",
    );
  });

  it("reports divergent rollback history without repeating the shared prefix", async () => {
    const { getAgentStepStore } = await import("@/chat/db");
    const conversationId = "slack:C1:rollback-reporting";
    await confirmPublicSlackConversation(conversationId);
    const stepStore = getAgentStepStore();
    const shared = {
      role: "user",
      content: [{ type: "text", text: "Regenerate the answer" }],
      timestamp: 1,
    } as PiMessage;

    await stepStore.startEpoch(conversationId, {
      reason: "initial",
      modelProfile: "standard",
      modelId: "openai/gpt-5.4",
      messages: [
        { message: shared, createdAtMs: 1 },
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Original answer" }],
            timestamp: 2,
          } as PiMessage,
          createdAtMs: 2,
        },
      ],
    });
    await stepStore.startEpoch(conversationId, {
      reason: "rollback",
      modelProfile: "standard",
      modelId: "openai/gpt-5.4",
      messages: [
        { message: shared, createdAtMs: 1 },
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Regenerated answer" }],
            timestamp: 3,
          } as PiMessage,
          createdAtMs: 3,
        },
      ],
    });

    const report = await readConversationDetailReport(conversationId);
    const serialized = report.transcript.map((message) =>
      JSON.stringify(message),
    );

    expect(report.contextEvents).toEqual([]);
    expect(
      serialized.filter((message) => message.includes("Regenerate the answer")),
    ).toHaveLength(1);
    expect(
      serialized.filter((message) => message.includes("Original answer")),
    ).toHaveLength(1);
    expect(
      serialized.filter((message) => message.includes("Regenerated answer")),
    ).toHaveLength(1);
  });

  it("reports ordered compaction and handoff events with a once-only transcript", async () => {
    const { getAgentStepStore } = await import("@/chat/db");
    const conversationId = "slack:C1:compaction-handoff-reporting";
    await confirmPublicSlackConversation(conversationId);
    const stepStore = getAgentStepStore();
    const original = {
      role: "user",
      content: [{ type: "text", text: "Finish the release work" }],
      timestamp: 1,
    } as PiMessage;

    await stepStore.startEpoch(conversationId, {
      reason: "initial",
      modelProfile: "standard",
      modelId: "openai/gpt-5.4",
      messages: [{ message: original, createdAtMs: 1 }],
    });
    await stepStore.startEpoch(conversationId, {
      reason: "compaction",
      modelProfile: "standard",
      modelId: "openai/gpt-5.4",
      messages: [
        { message: original, createdAtMs: 1 },
        {
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "Context compaction summary for future Junior turns:\nThe release plan is ready for implementation.",
              },
            ],
            timestamp: 2,
          } as PiMessage,
          createdAtMs: 2,
        },
      ],
    });
    await stepStore.append(conversationId, [
      {
        entry: {
          type: "pi_message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Compacted continuation" }],
            timestamp: 3,
          } as PiMessage,
        },
        createdAtMs: 3,
      },
    ]);
    await stepStore.startEpoch(conversationId, {
      reason: "handoff",
      modelProfile: "handoff",
      modelId: "openai/gpt-5.6-sol",
      messages: [
        {
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "Model handoff checkpoint. Continue the outstanding request now using this summary as the complete prior context:\nImplement the prepared release plan.",
              },
            ],
            timestamp: 4,
          } as PiMessage,
          createdAtMs: 4,
        },
      ],
    });
    await stepStore.append(conversationId, [
      {
        entry: {
          type: "pi_message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Handoff continuation" }],
            timestamp: 5,
          } as PiMessage,
        },
        createdAtMs: 5,
      },
    ]);

    const report = await readConversationDetailReport(conversationId);
    const transcript = JSON.stringify(report.transcript);

    expect(report.contextEvents).toEqual([
      expect.objectContaining({
        type: "context_compacted",
        modelId: "openai/gpt-5.4",
        summary: "The release plan is ready for implementation.",
      }),
      expect.objectContaining({
        type: "model_handoff",
        fromModelId: "openai/gpt-5.4",
        toModelId: "openai/gpt-5.6-sol",
        message:
          "Model handoff checkpoint. Continue the outstanding request now using this summary as the complete prior context:\nImplement the prepared release plan.",
      }),
    ]);
    expect(report.contextEvents?.[0]?.transcriptIndex).toBeLessThanOrEqual(
      report.contextEvents?.[1]?.transcriptIndex ?? -1,
    );
    expect(
      report.transcript.filter((message) =>
        JSON.stringify(message).includes("Finish the release work"),
      ),
    ).toHaveLength(1);
    expect(transcript).toContain("Compacted continuation");
    expect(transcript).toContain("Handoff continuation");
    expect(transcript).not.toContain("Context compaction summary");
    expect(transcript).not.toContain("Model handoff checkpoint");
  });
});
