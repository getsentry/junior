import { describe, expect, it } from "vitest";
import {
  convertAdvisorMessages,
  convertLegacySessionLog,
} from "@/cli/upgrade/migrations/conversation-history/legacy-history-import";
import type { PiMessage } from "@/chat/pi/messages";
import type { SessionLogEntry } from "@/cli/upgrade/migrations/conversation-history/session-log";

const CONVERSATION_ID = "slack:C1:1710000.0001";
const FALLBACK_MS = 1_000;
const MODEL_ID = "test/standard";

function userMessage(text: string, timestamp?: number): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    ...(timestamp !== undefined ? { timestamp } : {}),
  } as unknown as PiMessage;
}

function assistantMessage(text: string, timestamp?: number): PiMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    ...(timestamp !== undefined ? { timestamp } : {}),
  } as unknown as PiMessage;
}

function piEntry(
  message: PiMessage,
  sessionId: string,
  extra: Partial<Extract<SessionLogEntry, { type: "pi_message" }>> = {},
): SessionLogEntry {
  return {
    schemaVersion: 2,
    type: "pi_message",
    sessionId,
    message,
    ...extra,
  } as SessionLogEntry;
}

describe("operator legacy conversation history conversion", () => {
  it("keeps a single session in epoch 0 with sequential seq and message timestamps", () => {
    const { events, advisorChildConversationId } = convertLegacySessionLog({
      conversationId: CONVERSATION_ID,
      fallbackCreatedAtMs: FALLBACK_MS,
      modelId: MODEL_ID,
      entries: [
        piEntry(userMessage("hello", 10), "session_0"),
        piEntry(assistantMessage("hi", 20), "session_0"),
      ],
    });

    expect(advisorChildConversationId).toBeUndefined();
    expect(events).toEqual([
      {
        seq: 0,
        historyVersion: 0,
        createdAtMs: 10,
        data: {
          type: "agent_step",
          message: userMessage("hello", 10),
          provenance: { authority: "context" },
        },
      },
      {
        seq: 1,
        historyVersion: 0,
        createdAtMs: 20,
        data: {
          type: "agent_step",
          message: assistantMessage("hi", 20),
          provenance: { authority: "context" },
        },
      },
    ]);
  });

  it("normalizes legacy v1 entry-level actor into instruction provenance and drops actor_recorded", () => {
    const actor = {
      platform: "slack" as const,
      slackUserId: "U1",
      teamId: "T1",
      slackUserName: "ada",
    };
    const { events } = convertLegacySessionLog({
      conversationId: CONVERSATION_ID,
      fallbackCreatedAtMs: FALLBACK_MS,
      modelId: MODEL_ID,
      entries: [
        {
          schemaVersion: 1,
          type: "actor_recorded",
          sessionId: "session_0",
          actor,
        } as SessionLogEntry,
        piEntry(userMessage("do the thing", 30), "session_0", {
          schemaVersion: 1,
          actor,
        }),
      ],
    });

    // actor_recorded produces no row; the v1 pi_message decodes to an authored
    // instruction from the stored Slack actor.
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({
      type: "agent_step",
      message: userMessage("do the thing", 30),
      provenance: {
        authority: "instruction",
        actor: {
          platform: "slack",
          teamId: "T1",
          userId: "U1",
          userName: "ada",
        },
      },
    });
  });

  it("stores projection_reset as replacement history and keeps later messages in their source epoch", () => {
    const { events } = convertLegacySessionLog({
      conversationId: CONVERSATION_ID,
      fallbackCreatedAtMs: FALLBACK_MS,
      modelId: MODEL_ID,
      entries: [
        piEntry(userMessage("first", 10), "session_0"),
        {
          schemaVersion: 2,
          type: "projection_reset",
          sessionId: "session_1",
          messages: [userMessage("summary", 40), assistantMessage("ack", 41)],
        } as SessionLogEntry,
        // Stale write against the retired session after the reset.
        piEntry(userMessage("late-stale", 42), "session_0"),
        piEntry(userMessage("next", 43), "session_1"),
      ],
    });

    expect(
      events.map((event) => ({
        seq: event.seq,
        epoch: event.historyVersion,
        type: event.data.type,
      })),
    ).toEqual([
      { seq: 0, epoch: 0, type: "agent_step" },
      { seq: 1, epoch: 1, type: "compaction" },
      { seq: 2, epoch: 0, type: "agent_step" },
      { seq: 3, epoch: 1, type: "agent_step" },
    ]);
    expect(events[1]!.data).toMatchObject({
      type: "compaction",
      replacementHistory: [
        { message: userMessage("summary", 40) },
        { message: assistantMessage("ack", 41) },
      ],
    });
    // Highest epoch (current context) is exactly the reset's session rows.
    const currentEpoch = Math.max(
      ...events.map((event) => event.historyVersion),
    );
    expect(currentEpoch).toBe(1);
  });

  it("only rewrites the generated legacy checkpoint message", () => {
    const quotedPrefix = userMessage(
      "I quoted Context handoff summary for future Junior turns: in a request",
      10,
    );
    const legacyCheckpoint = userMessage(
      "Context handoff summary for future Junior turns:\nsummary",
      20,
    );
    const { events } = convertLegacySessionLog({
      conversationId: CONVERSATION_ID,
      fallbackCreatedAtMs: FALLBACK_MS,
      modelId: MODEL_ID,
      entries: [
        piEntry(quotedPrefix, "session_0"),
        {
          schemaVersion: 2,
          type: "projection_reset",
          sessionId: "session_1",
          messages: [quotedPrefix, legacyCheckpoint],
        } as SessionLogEntry,
      ],
    });

    expect(events[0]!.data).toMatchObject({
      type: "agent_step",
      message: quotedPrefix,
    });
    expect(events[1]!.data).toMatchObject({
      type: "compaction",
      replacementHistory: [
        { message: quotedPrefix },
        {
          message: userMessage(
            "Context compaction summary for future Junior turns:\nsummary",
            20,
          ),
        },
      ],
    });
  });

  it("converts an advisor subagent transcriptRef to a child conversation link and drops transcript cursors", () => {
    const { events, advisorChildConversationId } = convertLegacySessionLog({
      conversationId: CONVERSATION_ID,
      fallbackCreatedAtMs: FALLBACK_MS,
      modelId: MODEL_ID,
      entries: [
        {
          schemaVersion: 2,
          type: "subagent_started",
          sessionId: "session_0",
          subagentInvocationId: "call-1",
          subagentKind: "advisor",
          parentToolCallId: "call-1",
          parentConversationId: CONVERSATION_ID,
          transcriptRef: {
            type: "advisor_session",
            parentConversationId: CONVERSATION_ID,
            key: `junior:${CONVERSATION_ID}:advisor_session`,
          },
          historyMode: "shared",
          createdAtMs: 50,
        } as SessionLogEntry,
        {
          schemaVersion: 2,
          type: "subagent_ended",
          sessionId: "session_0",
          subagentInvocationId: "call-1",
          outcome: "success",
          transcriptStartMessageIndex: 0,
          transcriptEndMessageIndex: 2,
          createdAtMs: 60,
        } as SessionLogEntry,
      ],
    });

    expect(advisorChildConversationId).toBe(`advisor:${CONVERSATION_ID}`);
    expect(events[0]!.data).toEqual({
      type: "subagent_started",
      subagentInvocationId: "call-1",
      subagentKind: "advisor",
      parentToolCallId: "call-1",
      childConversationId: `advisor:${CONVERSATION_ID}`,
    });
    expect(events[0]!.createdAtMs).toBe(50);
    expect(events[1]!.data).toEqual({
      type: "subagent_ended",
      subagentInvocationId: "call-1",
      outcome: "success",
    });
  });

  it("falls back to the supplied conversation timestamp and never fabricates now", () => {
    const before = Date.now();
    const { events } = convertLegacySessionLog({
      conversationId: CONVERSATION_ID,
      fallbackCreatedAtMs: FALLBACK_MS,
      modelId: MODEL_ID,
      entries: [
        piEntry(userMessage("no timestamp"), "session_0"),
        {
          schemaVersion: 2,
          type: "mcp_provider_connected",
          sessionId: "session_0",
          provider: "github",
        } as SessionLogEntry,
      ],
    });

    expect(events.map((event) => event.createdAtMs)).toEqual([
      FALLBACK_MS,
      FALLBACK_MS,
    ]);
    // Guard against any Date.now() creeping in as a timestamp source.
    for (const event of events) {
      expect(event.createdAtMs).toBeLessThan(before);
    }
  });

  it("drops legacy tool arguments from canonical events", () => {
    const { events } = convertLegacySessionLog({
      conversationId: CONVERSATION_ID,
      fallbackCreatedAtMs: FALLBACK_MS,
      modelId: MODEL_ID,
      entries: [
        {
          schemaVersion: 2,
          type: "tool_execution_started",
          sessionId: "session_0",
          createdAtMs: 20,
          toolCallId: "legacy-tool-call",
          toolName: "legacy-tool",
          args: { token: "legacy-sensitive-token" },
        },
      ],
    });

    expect(events).toEqual([
      {
        seq: 0,
        historyVersion: 0,
        createdAtMs: 20,
        data: {
          type: "tool_execution_started",
          toolCallId: "legacy-tool-call",
          toolName: "legacy-tool",
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("legacy-sensitive-token");
  });
});

describe("convertAdvisorMessages", () => {
  it("normalizes advisor requests while mapping messages to child rows", () => {
    const rows = convertAdvisorMessages(
      [
        userMessage(
          "<advisor-task>\nReview &lt;change&gt; &amp; &quot;risk&quot;.\n</advisor-task>\n\n" +
            "<executor-context>\nUse owner=&apos;dashboard&apos; &amp; preserve &lt;context&gt;.\n</executor-context>",
          5,
        ),
        assistantMessage("a", 6),
        assistantMessage("no ts"),
      ],
      FALLBACK_MS,
    );

    expect(rows).toEqual([
      {
        seq: 0,
        historyVersion: 0,
        createdAtMs: 5,
        data: {
          type: "agent_step",
          message: userMessage(
            `Review <change> & "risk".\n\nExecutor context:\nUse owner='dashboard' & preserve <context>.`,
            5,
          ),
          provenance: { authority: "context" },
        },
      },
      {
        seq: 1,
        historyVersion: 0,
        createdAtMs: 6,
        data: {
          type: "agent_step",
          message: assistantMessage("a", 6),
          provenance: { authority: "context" },
        },
      },
      {
        seq: 2,
        historyVersion: 0,
        createdAtMs: FALLBACK_MS,
        data: {
          type: "agent_step",
          message: assistantMessage("no ts"),
          provenance: { authority: "context" },
        },
      },
    ]);
  });
});
