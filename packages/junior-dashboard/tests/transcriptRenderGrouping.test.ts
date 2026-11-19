import { describe, expect, it } from "vitest";
import type {
  ConversationReportEvent,
  ConversationReportEventData,
} from "@sentry/junior/api/schema";

import { groupTranscriptMessages } from "../src/client/conversations/transcriptRenderModel";
import { conversationTranscriptMessages } from "../src/client/conversations/eventTranscript";
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
    kind: "root",
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
    status: "done",
    turnActive: false,
    surface: "internal",
  };
}

describe("transcript render grouping", () => {
  it("keeps terminal failure outcomes as standalone entries", () => {
    const messages: TranscriptViewMessage[] = [
      {
        role: "assistant",
        failureCode: "model_execution_failed",
        sourceSeq: 42,
        timestamp: 1_000,
        parts: [],
      },
    ];
    expect(groupTranscriptMessages(messages)).toEqual([
      {
        key: "42:failure",
        kind: "failure",
        failureCode: "model_execution_failed",
        seq: 42,
        timestamp: 1_000,
      },
    ]);
  });

  it("keeps row identities stable when earlier events are prepended", () => {
    const current = conversationTranscriptMessages(
      conversation([
        event(10, "2026-01-01T00:00:10.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-10",
              name: "search",
              status: "completed",
              startedSeq: 6,
              startedAt: "2026-01-01T00:00:06.000Z",
              output: { matches: 1 },
            },
          ],
        }),
        event(11, "2026-01-01T00:00:11.000Z", {
          type: "message",
          messageId: "answer-11",
          role: "assistant",
          text: "current answer",
        }),
      ]),
    );
    const prepended = conversationTranscriptMessages(
      conversation([
        event(5, "2026-01-01T00:00:05.000Z", {
          type: "message",
          messageId: "question-5",
          role: "user",
          text: "earlier question",
        }),
        event(6, "2026-01-01T00:00:06.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-10",
              name: "search",
              status: "running",
            },
          ],
        }),
        event(10, "2026-01-01T00:00:10.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-10",
              name: "search",
              status: "completed",
              startedSeq: 6,
              startedAt: "2026-01-01T00:00:06.000Z",
              output: { matches: 1 },
            },
          ],
        }),
        event(11, "2026-01-01T00:00:11.000Z", {
          type: "message",
          messageId: "answer-11",
          role: "assistant",
          text: "current answer",
        }),
      ]),
    );

    const currentKeys = groupTranscriptMessages(current).map(
      (entry) => entry.key,
    );
    const prependedKeys = groupTranscriptMessages(prepended).map(
      (entry) => entry.key,
    );

    expect(current[0]).toMatchObject({
      sourceSeq: 6,
      timestamp: Date.parse("2026-01-01T00:00:06.000Z"),
      parts: [{ id: "search-10", status: "completed" }],
    });
    expect(currentKeys).toEqual(["tool:search-10", "11:message:0"]);
    expect(prependedKeys.slice(-currentKeys.length)).toEqual(currentKeys);
  });
  it("links each started Conversation and marks the one a later watch watches", () => {
    const start = (id: string, seq: number) =>
      event(seq, `2026-01-01T00:00:0${seq}.000Z`, {
        type: "tool_calls",
        calls: [
          {
            toolCallId: `start-${id}`,
            name: "startConversation",
            status: "completed",
            startedConversationId: `local:web:${id}`,
          },
        ],
      });
    const watch = (input: Record<string, string>) =>
      event(4, "2026-01-01T00:00:04.000Z", {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "watch-1",
            name: "watchEvents",
            status: "completed",
            input,
          },
        ],
      });
    const started = (events: ConversationReportEvent[]) =>
      conversationTranscriptMessages(conversation(events)).flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "tool_call" && part.startedConversation
            ? [part.startedConversation]
            : [],
        ),
      );

    expect(
      started([
        start("a", 1),
        start("b", 2),
        watch({
          identifier: "local:web:a",
          namespace: "junior",
          resource_type: "conversation",
        }),
      ]),
    ).toEqual([{ id: "local:web:a", watched: true }, { id: "local:web:b" }]);
    // A watch of another resource type does not count.
    expect(
      started([
        start("a", 1),
        watch({
          identifier: "local:web:a",
          namespace: "github",
          resource_type: "pull_request",
        }),
      ]),
    ).toEqual([{ id: "local:web:a" }]);
  });
});
