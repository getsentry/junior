import { describe, expect, it } from "vitest";
import type {
  ConversationReportEvent,
  ConversationReportEventData,
} from "@sentry/junior/api/schema";

import { messageRawText } from "../src/client/conversations/transcriptRenderModel";
import { conversationTranscriptMessages } from "../src/client/conversations/eventTranscript";
import type { ConversationTranscript } from "../src/client/types";

function event(
  seq: number,
  createdAt: string,
  data: ConversationReportEventData,
): ConversationReportEvent {
  return { seq, createdAt, data };
}

function conversation(
  events: ConversationReportEvent[],
): ConversationTranscript {
  return {
    conversationId: "conversation-1",
    cumulativeDurationMs: 0,
    displayTitle: "Conversation",
    eventHistory: { status: "available" },
    events,
    generatedAt: "2026-01-01T00:01:00.000Z",
    isParticipant: false,
    lastProgressAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    surface: "internal",
  };
}

describe("transcript message context classification", () => {
  it("hides unused non-mentions and marks turn inputs as context", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "message",
          messageId: "unused-context",
          role: "user",
          text: "ambient thread chatter",
          explicitMention: false,
        }),
        event(1, "2026-01-01T00:00:01.000Z", {
          type: "message",
          messageId: "used-context",
          role: "user",
          text: "can you clarify that?",
          explicitMention: false,
        }),
        event(2, "2026-01-01T00:00:02.000Z", {
          type: "turn_lifecycle",
          turnId: "turn-context",
          state: "started",
          inputMessageIds: ["used-context"],
        }),
        event(3, "2026-01-01T00:00:03.000Z", {
          type: "message",
          messageId: "answer",
          role: "assistant",
          text: "Here is the clarification.",
        }),
      ]),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      context: true,
      explicitMention: false,
      messageId: "used-context",
    });
    expect(messageRawText(messages[0]!)).toBe("can you clarify that?");
    expect(messages[1]?.messageId).toBe("answer");
  });

  it("keeps turn context on acted-on non-mention inputs", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "message",
          messageId: "used-context",
          role: "user",
          text: "can you clarify that?",
          explicitMention: false,
        }),
        event(1, "2026-01-01T00:00:01.000Z", {
          type: "turn_lifecycle",
          turnId: "turn-context",
          state: "started",
          inputMessageIds: ["used-context"],
        }),
        event(2, "2026-01-01T00:00:02.000Z", {
          type: "turn_context",
          turnId: "turn-context",
          pluginName: "memory",
          kind: "recall",
          version: 1,
          content: {
            memories: [
              {
                id: "memory-1",
                content: "Release notes live in Notion.",
                observedAtMs: 1_750_000_000_000,
                scope: "public",
                kind: "knowledge",
              },
            ],
          },
        }),
      ]),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      context: true,
      messageId: "used-context",
    });
    expect(messages[0]?.contexts).toHaveLength(1);
    expect(messages[0]?.contexts?.[0]).toMatchObject({
      kind: "recall",
      pluginName: "memory",
    });
  });
});
