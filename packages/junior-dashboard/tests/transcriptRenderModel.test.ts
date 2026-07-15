import { describe, expect, it } from "vitest";
import type {
  ConversationReportEvent,
  ConversationReportEventData,
} from "@sentry/junior/api/schema";

import { groupTranscriptMessages } from "../src/client/components/transcriptRenderModel";
import { entryMatchesSearch } from "../src/client/components/transcriptSearch";
import { conversationTranscriptMessages } from "../src/client/eventTranscript";
import type {
  ConversationTranscript,
  TranscriptViewMessage,
} from "../src/client/types";

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
    lastProgressAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    surface: "internal",
  };
}

describe("canonical event transcript reduction", () => {
  it("uses API sequence order even when timestamps are inverted", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        event(3, "2026-01-01T00:00:03.000Z", {
          type: "visible_message",
          messageId: "first",
          role: "user",
          text: "first by sequence",
        }),
        event(4, "2026-01-01T00:00:01.000Z", {
          type: "visible_message",
          messageId: "second",
          role: "assistant",
          text: "second by sequence",
        }),
      ]),
    );

    expect(messages.map((message) => message.parts[0]?.text)).toEqual([
      "first by sequence",
      "second by sequence",
    ]);
  });

  it("projects visible and redacted messages without duplicate model text", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "visible_message",
          messageId: "visible",
          role: "assistant",
          text: "safe answer",
        }),
        event(1, "2026-01-01T00:00:01.000Z", {
          type: "model_activity",
          activities: ["thinking", "tool_result"],
        }),
        event(2, "2026-01-01T00:00:02.000Z", {
          type: "visible_message",
          messageId: "private",
          role: "user",
          redacted: true,
        }),
      ]),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "safe answer" }]);
    expect(messages[1]?.parts).toEqual([{ type: "text", redacted: true }]);
  });

  it("renders tool starts as neutral structural events", () => {
    const [message] = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "tool_started",
          name: "search",
        }),
      ]),
    );

    expect(message?.parts).toEqual([{ type: "tool_call", name: "search" }]);
    expect(message?.parts[0]).not.toHaveProperty("status");
  });

  it("projects failures, context changes, and correlated child conversations", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "context_compacted",
        }),
        event(1, "2026-01-01T00:00:01.000Z", {
          type: "model_handoff",
        }),
        event(2, "2026-01-01T00:00:02.000Z", {
          type: "subagent_started",
          childConversationId: "child-1",
          subagentKind: "advisor",
        }),
        event(3, "2026-01-01T00:00:03.000Z", {
          type: "subagent_ended",
          childConversationId: "child-1",
          subagentKind: "advisor",
          outcome: "success",
        }),
        event(4, "2026-01-01T00:00:04.000Z", {
          type: "turn_lifecycle",
          turnId: "turn-1",
          state: "failed",
        }),
      ]),
    );
    const entries = groupTranscriptMessages(messages);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "context",
      "context",
      "subagent",
      "failure",
    ]);
    expect(entries[2]).toMatchObject({
      part: {
        childConversationId: "child-1",
        outcome: "success",
        status: "completed",
      },
    });
  });

  it("projects only failed deliveries as neutral failure history", () => {
    const entries = groupTranscriptMessages(
      conversationTranscriptMessages(
        conversation([
          event(0, "2026-01-01T00:00:00.000Z", {
            type: "delivery",
            deliveryId: "delivery-1",
            state: "intended",
          }),
          event(1, "2026-01-01T00:00:01.000Z", {
            type: "delivery",
            deliveryId: "delivery-1",
            state: "accepted",
          }),
          event(2, "2026-01-01T00:00:02.000Z", {
            type: "delivery",
            deliveryId: "delivery-2",
            state: "failed",
          }),
        ]),
      ),
    );

    expect(entries).toEqual([
      {
        kind: "failure",
        outcome: "delivery_failed",
        timestamp: Date.parse("2026-01-01T00:00:02.000Z"),
      },
    ]);
    expect(entryMatchesSearch(entries[0]!, "delivery failed")).toBe(true);
    expect(entryMatchesSearch(entries[0]!, "agent response failed")).toBe(
      false,
    );
  });

  it("searches canonical tool, failure, context, and subagent rows", () => {
    const entries = groupTranscriptMessages(
      conversationTranscriptMessages(
        conversation([
          event(0, "2026-01-01T00:00:00.000Z", {
            type: "tool_started",
            name: "sentry.search",
          }),
          event(1, "2026-01-01T00:00:01.000Z", {
            type: "subagent_started",
            childConversationId: "child-1",
            subagentKind: "advisor",
          }),
          event(2, "2026-01-01T00:00:02.000Z", {
            type: "context_compacted",
          }),
          event(3, "2026-01-01T00:00:03.000Z", {
            type: "turn_lifecycle",
            turnId: "turn-1",
            state: "failed",
          }),
        ]),
      ),
    );

    for (const query of ["sentry.search", "advisor", "compacted", "failed"]) {
      expect(entries.some((entry) => entryMatchesSearch(entry, query))).toBe(
        true,
      );
    }
  });
});

describe("transcript render grouping", () => {
  it("keeps terminal failure outcomes as standalone entries", () => {
    const messages: TranscriptViewMessage[] = [
      { role: "assistant", outcome: "error", timestamp: 1_000, parts: [] },
    ];
    expect(groupTranscriptMessages(messages)).toEqual([
      { kind: "failure", outcome: "error", timestamp: 1_000 },
    ]);
  });
});
