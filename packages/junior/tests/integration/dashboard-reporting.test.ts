import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import { readConversationDetail } from "@/api/conversations/detail";
import { readConversationSubagent as readConversationSubagentTranscriptReport } from "@/api/conversations/subagent";
import { buildTurnFailureResponse } from "@/chat/logging";

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

async function recordVisibleTranscript(
  conversationId: string,
  messages: Array<{
    role: "assistant" | "system" | "user";
    text: string;
    timestamp: number;
  }>,
) {
  const { getConversationEventStore } = await import("@/chat/db");
  await getConversationEventStore().append(
    conversationId,
    messages.map((message, index) => ({
      idempotencyKey: `test-visible:${message.timestamp}:${index}:${message.role}`,
      data: {
        type: "visible_message_recorded" as const,
        messageId: `visible:${message.timestamp}:${index}:${message.role}`,
        role: message.role,
        text: message.text,
      },
      createdAtMs: message.timestamp,
    })),
  );
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

  it("uses SQL title and visible events when model history is absent", async () => {
    const { getConversationEventStore, getConversationStore } =
      await import("@/chat/db");

    await confirmPublicSlackConversation("slack:C1:details-only");
    await getConversationStore().recordActivity({
      conversationId: "slack:C1:details-only",
      channelName: "proj-alpha",
      source: "slack",
      title: "SQL Title",
    });
    await getConversationEventStore().append("slack:C1:details-only", [
      {
        data: {
          type: "visible_message_recorded",
          messageId: "visible-only",
          role: "user",
          text: "Visible SQL message",
        },
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
    await recordVisibleTranscript("slack:C1:222", [
      { role: "user", text: "previous question", timestamp: 1 },
      { role: "assistant", text: "previous answer", timestamp: 2 },
      { role: "user", text: "current question", timestamp: 3 },
      { role: "assistant", text: "current answer", timestamp: 6 },
    ]);

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
        timestamp: 6,
        parts: [{ type: "text", text: "current answer" }],
      },
    ]);
  });

  it("reports private execution activity as safe metadata", async () => {
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { getConversationEventStore } = await import("@/chat/db");

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
    // Activity now derives from durable conversation events, not the Redis session log.
    await getConversationEventStore().append("slack:G1:activity", [
      {
        data: {
          type: "tool_execution_started",
          toolCallId: "advisor-call-1",
          toolName: "advisor",
          args: { question: "private question", context: "private context" },
        },
        createdAtMs: 2,
      },
      {
        data: {
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
        data: {
          type: "subagent_ended",
          subagentInvocationId: "advisor-call-1",
          outcome: "success",
        },
        createdAtMs: 5,
      },
    ]);
    await getConversationEventStore().startEpoch("slack:G1:activity", {
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
    const { getConversationEventStore, getConversationStore } =
      await import("@/chat/db");

    const conversationId = "slack:C1:subagent-slices";
    await confirmPublicSlackConversation(conversationId);
    const childConversationId = `task:${conversationId}`;
    const conversationStore = getConversationStore();
    const eventStore = getConversationEventStore();

    await conversationStore.ensureChildConversation({
      conversationId: childConversationId,
      parentConversationId: conversationId,
    });
    await eventStore.append(childConversationId, [
      {
        data: {
          type: "message",
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
        data: {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "first subagent answer" }],
            timestamp: 20,
          } as PiMessage,
        },
        createdAtMs: 20,
      },
      {
        data: {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "second subagent question" }],
            timestamp: 30,
          } as PiMessage,
        },
        createdAtMs: 30,
      },
      {
        data: {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "second subagent answer" }],
            timestamp: 40,
          } as PiMessage,
        },
        createdAtMs: 40,
      },
      {
        data: {
          type: "message",
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
      await eventStore.append(conversationId, [
        {
          data: {
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
          data: {
            type: "subagent_ended",
            subagentInvocationId: subagentId,
            outcome: "success",
          },
          createdAtMs: subagentId === "task-plan" ? 25 : 45,
        },
      ]);
    }
    await eventStore.append(conversationId, [
      {
        data: {
          type: "subagent_started",
          subagentInvocationId: "legacy-advisor",
          subagentKind: "advisor",
          childConversationId,
          historyMode: "shared",
        },
        createdAtMs: 50,
      },
      {
        data: {
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
    const { getConversationEventStore, getConversationStore } =
      await import("@/chat/db");

    const conversationId = "slack:D1:advisor-private";
    const toolCallId = "advisor-private";
    const privateAdvisorText = "private advisor question";
    const childConversationId = `advisor:${conversationId}`;
    const conversationStore = getConversationStore();
    const eventStore = getConversationEventStore();

    await conversationStore.ensureChildConversation({
      conversationId: childConversationId,
      parentConversationId: conversationId,
    });
    await eventStore.append(childConversationId, [
      {
        data: {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: privateAdvisorText }],
            timestamp: 10,
          } as PiMessage,
        },
        createdAtMs: 10,
      },
    ]);
    await eventStore.append(conversationId, [
      {
        data: {
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
        data: {
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
    const { getConversationEventStore } = await import("@/chat/db");

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
    // The subagent has no end event; its status derives from the parent tool's
    // completed result in the current epoch projection.
    await getConversationEventStore().append(
      "slack:C1:activity-parent-result",
      [
        {
          data: {
            type: "tool_execution_started",
            toolCallId: "advisor-call-parent",
            toolName: "advisor",
            args: { question: "public question" },
          },
          createdAtMs: 2,
        },
        {
          data: {
            type: "subagent_started",
            subagentInvocationId: "advisor-call-parent",
            subagentKind: "advisor",
            parentToolCallId: "advisor-call-parent",
            childConversationId: "advisor:slack:C1:activity-parent-result",
            historyMode: "shared",
          },
          createdAtMs: 3,
        },
      ],
    );

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

  it("keeps the complete visible transcript when steering adds a message", async () => {
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
    await recordVisibleTranscript("slack:C1:steering-transcript", [
      { role: "user", text: "previous question", timestamp: 1 },
      { role: "assistant", text: "previous answer", timestamp: 2 },
      { role: "user", text: "hello", timestamp: 3 },
      { role: "assistant", text: "working", timestamp: 4 },
      { role: "user", text: "steering message", timestamp: 5 },
      { role: "assistant", text: "done", timestamp: 6 },
    ]);

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
    const { getConversationEventStore, getConversationStore } =
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
    await getConversationEventStore().append("slack:C1:999", [
      {
        data: {
          type: "visible_message_recorded",
          messageId: "target-question",
          role: "user",
          text: "target question",
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

  it("extracts trace ids from authorized model history outside the visible transcript", async () => {
    const { getConversationEventStore } = await import("@/chat/db");
    const conversationId = "slack:C1:model-trace";
    const traceId = "0123456789abcdef0123456789abcdef";
    await confirmPublicSlackConversation(conversationId);
    await getConversationEventStore().append(conversationId, [
      {
        data: {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "trace-tool",
            toolName: "lookup",
            isError: false,
            content: [{ type: "text", text: `trace_id=${traceId}` }],
            timestamp: 2,
          } as PiMessage,
        },
        createdAtMs: 2,
      },
    ]);
    await recordVisibleTranscript(conversationId, [
      { role: "user", text: "look it up", timestamp: 1 },
      { role: "assistant", text: "done", timestamp: 3 },
    ]);

    const report = await readConversationDetailReport(conversationId);

    expect(report.traceId).toBe(traceId);
    expect(JSON.stringify(report.transcript)).not.toContain(traceId);
    expect(report.transcript).toEqual([
      {
        role: "user",
        timestamp: 1,
        parts: [{ type: "text", text: "look it up" }],
      },
      {
        role: "assistant",
        timestamp: 3,
        parts: [{ type: "text", text: "done" }],
      },
    ]);
  });

  it("reports terminal assistant outcomes without exposing provider errors", async () => {
    const { getConversationEventStore, getConversationStore } =
      await import("@/chat/db");
    const errorConversationId = "slack:C1:terminal-error";
    const abortedConversationId = "slack:D1:terminal-aborted";
    const sensitiveError =
      "xAI 503 credential=secret-provider-token upstream payload";

    await confirmPublicSlackConversation(errorConversationId);
    await getConversationEventStore().append(errorConversationId, [
      {
        data: {
          type: "message",
          message: {
            role: "assistant",
            api: "openai-responses",
            content: [],
            model: "grok-4.5",
            provider: "xai",
            stopReason: "error",
            errorMessage: sensitiveError,
            timestamp: 2,
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
          } as PiMessage,
        },
        createdAtMs: 2,
      },
    ]);

    await getConversationStore().recordActivity({
      conversationId: abortedConversationId,
      destination: {
        platform: "slack",
        teamId: "T1",
        channelId: "D1",
      },
      source: "slack",
      visibility: "private",
    });
    await getConversationEventStore().append(abortedConversationId, [
      {
        data: {
          type: "message",
          message: {
            role: "assistant",
            api: "openai-responses",
            content: [],
            model: "grok-4.5",
            provider: "xai",
            stopReason: "aborted",
            errorMessage: sensitiveError,
            timestamp: 3,
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
          } as PiMessage,
        },
        createdAtMs: 3,
      },
    ]);

    const errorReport = await readConversationDetailReport(errorConversationId);
    const abortedReport = await readConversationDetailReport(
      abortedConversationId,
    );

    expect(errorReport.transcript).toEqual([
      {
        role: "assistant",
        outcome: "error",
        parts: [],
        timestamp: 2,
      },
    ]);
    expect(errorReport.transcriptMessageCount).toBe(0);
    expect(abortedReport).toMatchObject({
      transcript: [],
      transcriptAvailable: false,
      transcriptMetadata: [
        {
          role: "assistant",
          outcome: "aborted",
          parts: [],
          timestamp: 3,
        },
      ],
      transcriptRedacted: true,
    });
    expect(JSON.stringify({ errorReport, abortedReport })).not.toContain(
      sensitiveError,
    );
    expect(JSON.stringify({ errorReport, abortedReport })).not.toContain(
      '"provider":"xai"',
    );
  });

  it("reports one safe lifecycle failure marker for public and private details", async () => {
    const { getConversationEventStore, getConversationStore } =
      await import("@/chat/db");
    const publicConversationId = "slack:C1:lifecycle-failure-public";
    const privateConversationId = "slack:D1:lifecycle-failure-private";
    const sensitiveError =
      "raw-error-sentinel https://provider.invalid/private?token=secret";
    const eventId = "0123456789abcdef0123456789abcdef";

    await confirmPublicSlackConversation(publicConversationId);
    await getConversationEventStore().append(publicConversationId, [
      {
        data: {
          type: "visible_message_recorded",
          messageId: "public-user",
          role: "user",
          text: "please retry",
        },
        createdAtMs: 1,
      },
      {
        data: {
          type: "turn_started",
          turnId: "turn-public",
          inputMessageIds: ["public-user"],
          surface: "slack",
        },
        createdAtMs: 2,
      },
      {
        data: {
          type: "message",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: sensitiveError,
            timestamp: 3,
          } as unknown as PiMessage,
        },
        createdAtMs: 3,
      },
      {
        data: {
          type: "visible_message_recorded",
          messageId: "public-fallback",
          role: "assistant",
          text: buildTurnFailureResponse(eventId),
        },
        createdAtMs: 4,
      },
      {
        data: {
          type: "turn_failed",
          turnId: "turn-public",
          failureCode: "model_execution_failed",
          eventId,
        },
        createdAtMs: 5,
      },
    ]);

    await getConversationStore().recordActivity({
      conversationId: privateConversationId,
      destination: {
        platform: "slack",
        teamId: "T1",
        channelId: "D1",
      },
      source: "slack",
      visibility: "private",
    });
    await getConversationEventStore().append(privateConversationId, [
      {
        data: {
          type: "turn_started",
          turnId: "turn-private",
          inputMessageIds: ["private-user"],
          surface: "slack",
        },
        createdAtMs: 10,
      },
      {
        data: {
          type: "visible_message_recorded",
          messageId: "private-fallback",
          role: "assistant",
          text: buildTurnFailureResponse(eventId),
        },
        createdAtMs: 10_500,
      },
      {
        data: {
          type: "turn_failed",
          turnId: "turn-private",
          failureCode: "delivery_failed",
          eventId,
        },
        createdAtMs: 11_000,
      },
    ]);

    const publicReport =
      await readConversationDetailReport(publicConversationId);
    const publicOutcomeMarkers = publicReport.transcript.filter(
      (message) => message.outcome === "error",
    );
    expect(publicOutcomeMarkers).toEqual([
      { role: "assistant", outcome: "error", parts: [], timestamp: 5 },
    ]);
    expect(publicReport.transcript).toContainEqual({
      role: "assistant",
      parts: [{ type: "text", text: buildTurnFailureResponse(eventId) }],
      timestamp: 4,
    });

    const privateReport = await readConversationDetailReport(
      privateConversationId,
    );
    expect(privateReport.transcript).toEqual([]);
    expect(privateReport.transcriptMetadata).toContainEqual({
      role: "assistant",
      parts: [expect.objectContaining({ type: "text", redacted: true })],
      timestamp: 10_500,
    });
    expect(privateReport.transcriptMetadata).toContainEqual({
      role: "assistant",
      outcome: "error",
      parts: [],
      timestamp: 11_000,
    });
    const publicSerialized = JSON.stringify(publicReport);
    expect(publicSerialized).toContain(eventId);
    expect(publicSerialized).not.toContain(sensitiveError);
    expect(publicSerialized).not.toContain("model_execution_failed");

    const privateSerialized = JSON.stringify(privateReport);
    expect(privateSerialized).not.toContain(eventId);
    expect(privateSerialized).not.toContain("delivery_failed");
    expect(privateSerialized).not.toContain(sensitiveError);
  });

  it("merges safe terminal outcomes chronologically with visible messages", async () => {
    const { getConversationEventStore } = await import("@/chat/db");
    const conversationId = "slack:C1:terminal-ordered";
    const sensitiveError = "provider=xai credential=secret";
    await confirmPublicSlackConversation(conversationId);
    await getConversationEventStore().append(conversationId, [
      {
        data: {
          type: "message",
          message: {
            role: "assistant",
            api: "openai-responses",
            content: [],
            model: "grok-4.5",
            provider: "xai",
            stopReason: "error",
            errorMessage: sensitiveError,
            timestamp: 2,
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
          } as PiMessage,
        },
        createdAtMs: 2,
      },
    ]);
    await recordVisibleTranscript(conversationId, [
      { role: "user", text: "please retry", timestamp: 1 },
      { role: "assistant", text: "safe fallback", timestamp: 3 },
    ]);

    const report = await readConversationDetailReport(conversationId);

    expect(report.transcript).toEqual([
      {
        role: "user",
        timestamp: 1,
        parts: [{ type: "text", text: "please retry" }],
      },
      { role: "assistant", outcome: "error", parts: [], timestamp: 2 },
      {
        role: "assistant",
        timestamp: 3,
        parts: [{ type: "text", text: "safe fallback" }],
      },
    ]);
    expect(report.transcriptMessageCount).toBe(2);
    expect(JSON.stringify(report)).not.toContain(sensitiveError);
    expect(JSON.stringify(report)).not.toContain('"provider":"xai"');
  });

  it("keeps SQL detail available when optional execution settings fail", async () => {
    const { getConversationEventStore, getConversationStore } =
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
    await getConversationEventStore().append(conversationId, [
      {
        data: {
          type: "visible_message_recorded",
          messageId: "available-transcript",
          role: "user",
          text: "available transcript",
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

  it("reports multiple exchanges as one complete visible transcript", async () => {
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
    await recordVisibleTranscript("slack:C1:333", [
      { role: "user", text: "first question", timestamp: 1 },
      { role: "assistant", text: "first answer", timestamp: 2 },
      { role: "user", text: "second question", timestamp: 3 },
      { role: "assistant", text: "second answer", timestamp: 4 },
    ]);

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
    await recordVisibleTranscript("slack:D1:222", [
      { role: "user", text: "private question", timestamp: 1 },
      { role: "assistant", text: "private answer", timestamp: 2 },
    ]);

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
    expect(report.transcriptMetadata).toEqual([
      {
        role: "user",
        parts: [{ type: "text", bytes: 16, chars: 16, redacted: true }],
        timestamp: 1,
      },
      {
        role: "assistant",
        parts: [{ type: "text", bytes: 14, chars: 14, redacted: true }],
        timestamp: 2,
      },
    ]);
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
    const { getConversationEventStore } = await import("@/chat/db");

    const conversationId = "slack:C1:compaction";
    await confirmPublicSlackConversation(conversationId);
    const eventStore = getConversationEventStore();

    // Epoch 0: execution that remains visible after a later context rebuild.
    await eventStore.append(conversationId, [
      {
        data: {
          type: "message",
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
        data: {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "old question" }],
            timestamp: 1,
          } as PiMessage,
        },
        createdAtMs: 1,
      },
      {
        data: {
          type: "message",
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
        data: {
          type: "message",
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
        data: {
          type: "tool_execution_started",
          toolCallId: "old-tool",
          toolName: "search",
        },
        createdAtMs: 3,
      },
    ]);
    // Compaction copies the latest user intent and adds a generated summary.
    await eventStore.startEpoch(conversationId, {
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
    await eventStore.append(conversationId, [
      {
        data: {
          type: "message",
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
        data: {
          type: "tool_execution_started",
          toolCallId: "new-tool",
          toolName: "search",
          args: { q: "current question" },
        },
        createdAtMs: 5,
      },
    ]);
    await recordVisibleTranscript(conversationId, [
      {
        role: "user",
        text: "Context compaction summary for future Junior turns:\nThis is quoted documentation, not a generated summary.",
        timestamp: 0,
      },
      { role: "user", text: "old question", timestamp: 1 },
      { role: "user", text: "current question", timestamp: 2 },
      {
        role: "user",
        text: "Context compaction summary for future Junior turns:\nPlease explain this marker to the user.",
        timestamp: 4.5,
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
    ).toHaveLength(1);
  });

  it("reports the original execution and continuation around a model handoff", async () => {
    const { getConversationEventStore } = await import("@/chat/db");
    const conversationId = "slack:C1:handoff-reporting";
    await confirmPublicSlackConversation(conversationId);
    const eventStore = getConversationEventStore();

    await eventStore.startEpoch(conversationId, {
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
    await eventStore.startEpoch(conversationId, {
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
    await eventStore.append(conversationId, [
      {
        data: {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I prepared the ordering fix." }],
            timestamp: 4,
          } as PiMessage,
        },
        createdAtMs: 4,
      },
    ]);
    await recordVisibleTranscript(conversationId, [
      {
        role: "user",
        text: "Model handoff checkpoint. Continue the outstanding request now using this summary as the complete prior context:\nThis is quoted documentation, not a generated checkpoint.",
        timestamp: 0,
      },
      { role: "user", text: "Investigate the release", timestamp: 1 },
      {
        role: "assistant",
        text: "I prepared the ordering fix.",
        timestamp: 4,
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
    ).toHaveLength(1);
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
    const { getConversationEventStore } = await import("@/chat/db");
    const conversationId = "slack:C1:rollback-reporting";
    await confirmPublicSlackConversation(conversationId);
    const eventStore = getConversationEventStore();
    const shared = {
      role: "user",
      content: [{ type: "text", text: "Regenerate the answer" }],
      timestamp: 1,
    } as PiMessage;

    await eventStore.startEpoch(conversationId, {
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
    await recordVisibleTranscript(conversationId, [
      { role: "user", text: "Regenerate the answer", timestamp: 1 },
      { role: "assistant", text: "Original answer", timestamp: 2 },
      { role: "assistant", text: "Regenerated answer", timestamp: 3 },
    ]);
    await eventStore.startEpoch(conversationId, {
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
    const { getConversationEventStore } = await import("@/chat/db");
    const conversationId = "slack:C1:compaction-handoff-reporting";
    await confirmPublicSlackConversation(conversationId);
    const eventStore = getConversationEventStore();
    const original = {
      role: "user",
      content: [{ type: "text", text: "Finish the release work" }],
      timestamp: 1,
    } as PiMessage;

    await eventStore.startEpoch(conversationId, {
      reason: "initial",
      modelProfile: "standard",
      modelId: "openai/gpt-5.4",
      messages: [{ message: original, createdAtMs: 1 }],
    });
    await eventStore.startEpoch(conversationId, {
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
    await eventStore.append(conversationId, [
      {
        data: {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Compacted continuation" }],
            timestamp: 3,
          } as PiMessage,
        },
        createdAtMs: 3,
      },
    ]);
    await eventStore.startEpoch(conversationId, {
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
    await eventStore.append(conversationId, [
      {
        data: {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Handoff continuation" }],
            timestamp: 5,
          } as PiMessage,
        },
        createdAtMs: 5,
      },
    ]);
    await recordVisibleTranscript(conversationId, [
      { role: "user", text: "Finish the release work", timestamp: 1 },
      { role: "assistant", text: "Compacted continuation", timestamp: 3 },
      { role: "assistant", text: "Handoff continuation", timestamp: 5 },
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
