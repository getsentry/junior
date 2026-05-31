import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";

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
      sessionId: "turn-2",
      state: "awaiting_resume",
      resumeReason: "timeout",
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
          content: [{ type: "text", text: "current answer" }],
          timestamp: 4,
        },
      ] as PiMessage[],
    });

    const report =
      await createJuniorReporting().getConversation("slack:C1:222");

    expect(report.turns).toHaveLength(1);
    expect(report.turns[0]!.transcript).toEqual([
      {
        role: "user",
        timestamp: 3,
        parts: [{ type: "text", text: "current question" }],
      },
      {
        role: "assistant",
        timestamp: 4,
        parts: [{ type: "text", text: "current answer" }],
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

    expect(report.turns).toHaveLength(1);
    expect(report.turns[0]).toMatchObject({
      id: "target-turn",
      transcriptAvailable: true,
    });
    expect(report.turns[0]!.transcript).toEqual([
      {
        role: "user",
        timestamp: 1,
        parts: [{ type: "text", text: "target question" }],
      },
    ]);
  });

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

    expect(report.turns).toHaveLength(2);
    expect(report.turns[0]).toMatchObject({ id: "turn-one" });
    expect(report.turns[0]!.transcript).toEqual([
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
    expect(report.turns[1]).toMatchObject({ id: "turn-two" });
    expect(report.turns[1]!.transcript).toEqual([
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
    const { createJuniorReporting } = await import("@/reporting");
    const privateToolArgs = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [
        `privateKey${index}`,
        `private value ${index}`,
      ]),
    );

    await upsertAgentTurnSessionRecord({
      conversationId: "slack:D1:222",
      sessionId: "turn-private",
      sliceId: 1,
      state: "completed",
      channelName: "secret-dm-name",
      conversationTitle: "sensitive generated thread title",
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

    expect(report.turns[0]).toMatchObject({
      conversationTitle: "Direct Message",
      channelName: "Direct Message",
      id: "turn-private",
      traceId: "0123456789abcdef0123456789abcdef",
      transcriptAvailable: false,
      transcriptMessageCount: 2,
      transcriptRedacted: true,
      transcriptRedactionReason: "non_public_conversation",
      transcript: [],
    });
    expect(JSON.stringify(report)).not.toContain("private question");
    expect(JSON.stringify(report)).not.toContain("private answer");
    expect(JSON.stringify(report)).not.toContain("private value");
    expect(JSON.stringify(report)).not.toContain(
      "sensitive generated thread title",
    );
    expect(JSON.stringify(report)).not.toContain("secret-dm-name");
    const toolCall = report.turns[0]!.transcriptMetadata?.[1]?.parts.find(
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

    expect(report.turns[0]).toMatchObject({
      conversationTitle: "Direct Message",
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
