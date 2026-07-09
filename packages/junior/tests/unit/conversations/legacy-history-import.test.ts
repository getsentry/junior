import { describe, expect, it } from "vitest";
import {
  convertAdvisorMessages,
  convertLegacySessionLog,
} from "@/chat/conversations/sql/legacy-history-import";
import type { PiMessage } from "@/chat/pi/messages";
import type { SessionLogEntry } from "@/chat/state/session-log";

const CONVERSATION_ID = "slack:C1:1710000.0001";
const FALLBACK_MS = 1_000;

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

describe("convertLegacySessionLog", () => {
  it("keeps a single session in epoch 0 with sequential seq and message timestamps", () => {
    const { steps, advisorChildConversationId } = convertLegacySessionLog({
      conversationId: CONVERSATION_ID,
      fallbackCreatedAtMs: FALLBACK_MS,
      entries: [
        piEntry(userMessage("hello", 10), "session_0"),
        piEntry(assistantMessage("hi", 20), "session_0"),
      ],
    });

    expect(advisorChildConversationId).toBeUndefined();
    expect(steps).toEqual([
      {
        seq: 0,
        contextEpoch: 0,
        createdAtMs: 10,
        entry: {
          type: "pi_message",
          message: userMessage("hello", 10),
          provenance: { authority: "context" },
        },
      },
      {
        seq: 1,
        contextEpoch: 0,
        createdAtMs: 20,
        entry: {
          type: "pi_message",
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
    const { steps } = convertLegacySessionLog({
      conversationId: CONVERSATION_ID,
      fallbackCreatedAtMs: FALLBACK_MS,
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
    expect(steps).toHaveLength(1);
    expect(steps[0]!.entry).toEqual({
      type: "pi_message",
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

  it("explodes projection_reset into an epoch marker plus per-message rows and keeps stale sessions in their epoch", () => {
    const { steps } = convertLegacySessionLog({
      conversationId: CONVERSATION_ID,
      fallbackCreatedAtMs: FALLBACK_MS,
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
      steps.map((step) => ({
        seq: step.seq,
        epoch: step.contextEpoch,
        type: step.entry.type,
      })),
    ).toEqual([
      { seq: 0, epoch: 0, type: "pi_message" },
      { seq: 1, epoch: 1, type: "context_epoch_started" },
      { seq: 2, epoch: 1, type: "pi_message" },
      { seq: 3, epoch: 1, type: "pi_message" },
      { seq: 4, epoch: 0, type: "pi_message" },
      { seq: 5, epoch: 1, type: "pi_message" },
    ]);
    expect(steps[1]!.entry).toEqual({
      type: "context_epoch_started",
      reason: "compaction",
    });
    // Highest epoch (current context) is exactly the reset's session rows.
    const currentEpoch = Math.max(...steps.map((step) => step.contextEpoch));
    expect(currentEpoch).toBe(1);
  });

  it("converts an advisor subagent transcriptRef to a child conversation link and drops transcript cursors", () => {
    const { steps, advisorChildConversationId } = convertLegacySessionLog({
      conversationId: CONVERSATION_ID,
      fallbackCreatedAtMs: FALLBACK_MS,
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
    expect(steps[0]!.entry).toEqual({
      type: "subagent_started",
      subagentInvocationId: "call-1",
      subagentKind: "advisor",
      parentToolCallId: "call-1",
      childConversationId: `advisor:${CONVERSATION_ID}`,
      historyMode: "shared",
    });
    expect(steps[0]!.createdAtMs).toBe(50);
    expect(steps[1]!.entry).toEqual({
      type: "subagent_ended",
      subagentInvocationId: "call-1",
      outcome: "success",
    });
  });

  it("falls back to the supplied conversation timestamp and never fabricates now", () => {
    const before = Date.now();
    const { steps } = convertLegacySessionLog({
      conversationId: CONVERSATION_ID,
      fallbackCreatedAtMs: FALLBACK_MS,
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

    expect(steps.map((step) => step.createdAtMs)).toEqual([
      FALLBACK_MS,
      FALLBACK_MS,
    ]);
    // Guard against any Date.now() creeping in as a timestamp source.
    for (const step of steps) {
      expect(step.createdAtMs).toBeLessThan(before);
    }
  });
});

describe("convertAdvisorMessages", () => {
  it("maps advisor messages to epoch-0 pi_message rows with message timestamps", () => {
    const rows = convertAdvisorMessages(
      [
        userMessage("q", 5),
        assistantMessage("a", 6),
        assistantMessage("no ts"),
      ],
      FALLBACK_MS,
    );

    expect(rows).toEqual([
      {
        seq: 0,
        contextEpoch: 0,
        createdAtMs: 5,
        entry: {
          type: "pi_message",
          message: userMessage("q", 5),
          provenance: { authority: "context" },
        },
      },
      {
        seq: 1,
        contextEpoch: 0,
        createdAtMs: 6,
        entry: {
          type: "pi_message",
          message: assistantMessage("a", 6),
          provenance: { authority: "context" },
        },
      },
      {
        seq: 2,
        contextEpoch: 0,
        createdAtMs: FALLBACK_MS,
        entry: {
          type: "pi_message",
          message: assistantMessage("no ts"),
          provenance: { authority: "context" },
        },
      },
    ]);
  });
});
