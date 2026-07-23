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
          type: "message",
          messageId: "first",
          role: "user",
          text: "first by sequence",
        }),
        event(4, "2026-01-01T00:00:01.000Z", {
          type: "message",
          messageId: "second",
          role: "assistant",
          text: "second by sequence",
        }),
      ]),
    );

    expect(
      messages.map((message) => {
        const part = message.parts[0];
        return part?.type === "text" ? part.text : undefined;
      }),
    ).toEqual(["first by sequence", "second by sequence"]);
  });

  it("projects visible and redacted messages", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "message",
          messageId: "visible",
          role: "assistant",
          text: "safe answer",
        }),
        event(2, "2026-01-01T00:00:02.000Z", {
          type: "message",
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

  it("preserves resource event type for special rendering", () => {
    const [message] = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "message",
          messageId: "event-1",
          role: "user",
          eventType: "pull_request.merged",
          text: "line one\nline two",
        }),
      ]),
    );

    expect(message).toMatchObject({
      eventType: "pull_request.merged",
      parts: [{ type: "text", text: "line one\nline two" }],
    });
    const [entry] = groupTranscriptMessages(message ? [message] : []);
    expect(entry && entryMatchesSearch(entry, "pull_request.merged")).toBe(
      true,
    );
  });

  it("renders a tool start as one running invocation", () => {
    const [message] = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "tool_started",
          toolCallId: "search-1",
          name: "search",
        }),
      ]),
    );

    expect(message?.parts).toEqual([
      {
        type: "tool_call",
        id: "search-1",
        name: "search",
        status: "running",
      },
    ]);
  });

  it("enriches one tool row in place when call details and a result arrive", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "tool_started",
          toolCallId: "search-1",
          name: "search",
        }),
        event(1, "2026-01-01T00:00:01.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              input: { query: "regression" },
            },
          ],
        }),
        event(2, "2026-01-01T00:00:03.000Z", {
          type: "tool_result",
          toolCallId: "search-1",
          outcome: "completed",
          output: { matches: 2 },
        }),
      ]),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts).toEqual([
      {
        type: "tool_call",
        id: "search-1",
        input: { query: "regression" },
        name: "search",
        output: { matches: 2 },
        resultTimestamp: Date.parse("2026-01-01T00:00:03.000Z"),
        status: "completed",
      },
    ]);
  });

  it("replaces correlated tool facts with special lifecycle rows", () => {
    const entries = groupTranscriptMessages(
      conversationTranscriptMessages(
        conversation([
          event(1, "2026-01-01T00:00:01.000Z", {
            type: "subagent_started",
            childConversationId: "child-correlated",
            subagentKind: "advisor",
            parentToolCallId: "advisor-correlated",
          }),
          event(2, "2026-01-01T00:00:02.000Z", {
            type: "subagent_ended",
            startedSeq: 1,
            outcome: "success",
          }),
          event(3, "2026-01-01T00:00:03.000Z", {
            type: "tool_started",
            toolCallId: "advisor-visible",
            name: "advisor",
          }),
          event(5, "2026-01-01T00:00:05.000Z", {
            type: "handoff",
            triggeringToolCallId: "handoff-correlated",
          }),
          event(6, "2026-01-01T00:00:06.000Z", {
            type: "subagent_started",
            childConversationId: "child-legacy",
            subagentKind: "advisor",
          }),
          event(7, "2026-01-01T00:00:07.000Z", {
            type: "handoff",
          }),
          event(8, "2026-01-01T00:00:08.000Z", {
            type: "tool_calls",
            calls: [
              {
                toolCallId: "advisor-correlated",
                name: "advisor",
                input: { task: "review" },
              },
              {
                toolCallId: "handoff-correlated",
                name: "handoff",
                input: { profile: "fast" },
              },
            ],
          }),
          event(9, "2026-01-01T00:00:09.000Z", {
            type: "tool_result",
            toolCallId: "advisor-correlated",
            outcome: "completed",
            output: { ok: true },
          }),
          event(10, "2026-01-01T00:00:10.000Z", {
            type: "tool_result",
            toolCallId: "handoff-correlated",
            outcome: "completed",
            output: { ok: true },
          }),
        ]),
      ),
    );

    expect(
      entries.map((entry) => ({
        kind: entry.kind,
        name: entry.kind === "tool" ? entry.part.name : undefined,
        status: entry.kind === "subagent" ? entry.part.status : undefined,
      })),
    ).toEqual([
      { kind: "subagent", name: undefined, status: "completed" },
      { kind: "tool", name: "advisor", status: undefined },
      { kind: "context", name: undefined, status: undefined },
      { kind: "subagent", name: undefined, status: "running" },
      { kind: "context", name: undefined, status: undefined },
    ]);
  });

  it("projects failures, context changes, and correlated child conversations", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "compaction",
        }),
        event(1, "2026-01-01T00:00:01.000Z", {
          type: "handoff",
        }),
        event(2, "2026-01-01T00:00:02.000Z", {
          type: "subagent_started",
          childConversationId: "child-1",
          subagentKind: "advisor",
        }),
        event(3, "2026-01-01T00:00:03.000Z", {
          type: "subagent_ended",
          startedSeq: 2,
          outcome: "success",
        }),
        event(4, "2026-01-01T00:00:04.000Z", {
          type: "turn_lifecycle",
          turnId: "turn-1",
          state: "failed",
          failureKind: "agent",
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
        status: "completed",
      },
    });
  });

  it("correlates repeated child outcomes by start sequence", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "subagent_started",
          childConversationId: "child-1",
          subagentKind: "advisor",
        }),
        event(1, "2026-01-01T00:00:01.000Z", {
          type: "subagent_started",
          childConversationId: "child-1",
          subagentKind: "advisor",
        }),
        event(2, "2026-01-01T00:00:02.000Z", {
          type: "subagent_ended",
          startedSeq: 1,
          outcome: "success",
        }),
        event(3, "2026-01-01T00:00:03.000Z", {
          type: "subagent_ended",
          startedSeq: 0,
          outcome: "error",
        }),
      ]),
    );

    expect(messages.map((message) => message.parts[0])).toMatchObject([
      { status: "error" },
      { status: "completed" },
    ]);
  });

  it("searches canonical tool, failure, context, and subagent rows", () => {
    const entries = groupTranscriptMessages(
      conversationTranscriptMessages(
        conversation([
          event(0, "2026-01-01T00:00:00.000Z", {
            type: "tool_started",
            toolCallId: "search-1",
            name: "sentry.search",
          }),
          event(1, "2026-01-01T00:00:01.000Z", {
            type: "tool_calls",
            calls: [
              {
                toolCallId: "search-1",
                name: "sentry.search",
                input: { project: "checkout-project" },
              },
            ],
          }),
          event(2, "2026-01-01T00:00:02.000Z", {
            type: "tool_result",
            toolCallId: "search-1",
            outcome: "completed",
            output: { culprit: "payments-v42" },
          }),
          event(3, "2026-01-01T00:00:03.000Z", {
            type: "subagent_started",
            childConversationId: "child-1",
            subagentKind: "advisor",
          }),
          event(4, "2026-01-01T00:00:04.000Z", {
            type: "compaction",
          }),
          event(5, "2026-01-01T00:00:05.000Z", {
            type: "turn_lifecycle",
            turnId: "turn-1",
            state: "failed",
            failureKind: "agent",
          }),
          event(6, "2026-01-01T00:00:06.000Z", {
            type: "turn_lifecycle",
            turnId: "turn-2",
            state: "failed",
            failureKind: "delivery",
          }),
        ]),
      ),
    );

    for (const query of [
      "sentry.search",
      "checkout-project",
      "payments-v42",
      "advisor",
      "completed",
      "compacted",
      "failed",
      "delivery failed",
    ]) {
      expect(entries.some((entry) => entryMatchesSearch(entry, query))).toBe(
        true,
      );
    }
    expect(entries.some((entry) => entryMatchesSearch(entry, "child-1"))).toBe(
      false,
    );
    expect(entries.some((entry) => entryMatchesSearch(entry, "started"))).toBe(
      false,
    );
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
