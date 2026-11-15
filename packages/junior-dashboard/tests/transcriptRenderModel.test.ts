import { describe, expect, it } from "vitest";
import type {
  ConversationReportEvent,
  ConversationReportEventData,
} from "@sentry/junior/api/schema";

import {
  groupTranscriptMessages,
  messageRawText,
} from "../src/client/conversations/transcriptRenderModel";
import { entryMatchesSearch } from "../src/client/conversations/transcriptSearch";
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
        event(5, "2026-01-01T00:00:02.000Z", {
          type: "assistant_message",
          parts: [],
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

  it("resolves cards from current annotations without changing Message events", () => {
    const ref = { kind: "object" as const, plugin: "github", key: "repo#1" };
    const current = conversation([
      event(0, "2026-01-01T00:00:00.000Z", {
        type: "message",
        messageId: "visible",
        role: "assistant",
        text: "safe answer",
        cards: [ref],
      }),
      event(2, "2026-01-01T00:00:02.000Z", {
        type: "message",
        messageId: "private",
        role: "user",
        redacted: true,
      }),
    ]);
    const annotation = {
      ...ref,
      objectType: "code_change" as const,
      title: "Fix the parser",
      label: "repo#1",
      url: "https://example.com/pull/1",
      status: "open",
      createdAt: current.generatedAt,
      updatedAt: current.generatedAt,
    };
    current.annotations = [annotation];
    const messages = conversationTranscriptMessages(current);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "safe answer" }]);
    expect(messages[1]?.parts).toEqual([{ type: "text", redacted: true }]);
    expect(messages[1]?.cards).toBeUndefined();
    expect(messageRawText(messages[0]!)).toContain("open");

    const updated = conversationTranscriptMessages({
      ...current,
      annotations: [{ ...annotation, status: "merged" }],
    });
    expect(messageRawText(updated[0]!)).toContain("merged");
    expect(
      entryMatchesSearch(groupTranscriptMessages(updated)[0]!, "merged"),
    ).toBe(true);
    expect(current.events[0]?.data).toMatchObject({ cards: [ref] });

    const missing = conversationTranscriptMessages({
      ...current,
      annotations: [],
    });
    expect(missing[0]?.cards).toEqual([
      {
        ...ref,
        objectType: "item",
        title: "repo#1",
        label: "repo#1",
        url: null,
        warning: "Saved annotation is unavailable.",
      },
    ]);
  });

  it("preserves ordered reasoning and tool activity", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "running",
            },
          ],
        }),
        event(1, "2026-01-01T00:00:01.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "running",
              startedAt: "2026-01-01T00:00:01.000Z",
              startedSeq: 1,
            },
          ],
          assistant: {
            parts: [
              { type: "reasoning", text: "Inspect the inputs." },
              { type: "tool_call", toolCallId: "search-1" },
              { type: "reasoning", text: "Check the result." },
            ],
          },
        }),
      ]),
    );

    expect(groupTranscriptMessages(messages)).toEqual([
      {
        key: "1:reasoning:0",
        kind: "reasoning",
        part: { type: "reasoning", text: "Inspect the inputs." },
        seq: 1,
        timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
      },
      {
        key: "tool:search-1",
        kind: "tool",
        part: {
          type: "tool_call",
          id: "search-1",
          name: "search",
          startedTimestamp: Date.parse("2026-01-01T00:00:00.000Z"),
          status: "running",
        },
        seq: 1,
        timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
      },
      {
        key: "1:reasoning:2",
        kind: "reasoning",
        part: { type: "reasoning", text: "Check the result." },
        seq: 1,
        timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
      },
    ]);
  });

  it("keeps Event fields for transcript display", () => {
    const [message] = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "message",
          messageId: "event-1",
          role: "user",
          eventType: "pull_request.merged",
          trustedSummary: "David merged PR #42.",
          text: "line one\nline two",
        }),
        event(1, "2026-01-01T00:00:01.000Z", {
          type: "turn_lifecycle",
          turnId: "turn-1",
          state: "started",
          inputMessageIds: ["event-1"],
        }),
        event(2, "2026-01-01T00:00:02.000Z", {
          type: "turn_lifecycle",
          turnId: "turn-1",
          state: "no_reply",
        }),
      ]),
    );

    expect(message).toMatchObject({
      eventType: "pull_request.merged",
      noReply: true,
      trustedSummary: "David merged PR #42.",
      parts: [{ type: "text", text: "line one\nline two" }],
    });
    const [entry] = groupTranscriptMessages(message ? [message] : []);
    expect(entry && entryMatchesSearch(entry, "pull_request.merged")).toBe(
      true,
    );
    expect(entry && entryMatchesSearch(entry, "david merged")).toBe(true);
  });

  it("renders a tool start as one running invocation", () => {
    const [message] = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "running",
              input: { query: "regression" },
            },
          ],
        }),
      ]),
    );

    expect(message?.parts).toEqual([
      {
        type: "tool_call",
        id: "search-1",
        input: { query: "regression" },
        name: "search",
        status: "running",
      },
    ]);
  });

  it("enriches one tool row in place when call details and a result arrive", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "running",
            },
          ],
        }),
        event(1, "2026-01-01T00:00:01.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "running",
              input: { query: "regression" },
            },
          ],
        }),
        event(2, "2026-01-01T00:00:03.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "completed",
              startedSeq: 0,
              startedAt: "2026-01-01T00:00:00.000Z",
              output: { matches: 2 },
            },
          ],
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
        startedTimestamp: Date.parse("2026-01-01T00:00:00.000Z"),
        status: "completed",
      },
    ]);
  });

  it("moves an earlier tool start into the ordered assistant message", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "running",
            },
          ],
        }),
        event(1, "2026-01-01T00:00:01.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "running",
              startedAt: "2026-01-01T00:00:01.000Z",
              startedSeq: 1,
              input: { query: "regression" },
            },
          ],
          assistant: {
            parts: [
              { type: "reasoning", text: "Inspect the inputs." },
              { type: "tool_call", toolCallId: "search-1" },
            ],
          },
        }),
        event(2, "2026-01-01T00:00:03.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "completed",
              startedSeq: 0,
              startedAt: "2026-01-01T00:00:00.000Z",
              output: { matches: 2 },
            },
          ],
        }),
      ]),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts).toEqual([
      { type: "reasoning", text: "Inspect the inputs." },
      {
        type: "tool_call",
        id: "search-1",
        input: { query: "regression" },
        name: "search",
        output: { matches: 2 },
        resultTimestamp: Date.parse("2026-01-01T00:00:03.000Z"),
        startedTimestamp: Date.parse("2026-01-01T00:00:00.000Z"),
        status: "completed",
      },
    ]);
    expect(groupTranscriptMessages(messages)).toMatchObject([
      { kind: "reasoning" },
      {
        kind: "tool",
        timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
      },
    ]);
  });

  it("keeps a later operational tool row after assistant reasoning", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        event(1, "2026-01-01T00:00:02.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "running",
              startedAt: "2026-01-01T00:00:02.000Z",
              startedSeq: 1,
              input: { query: "regression" },
            },
          ],
          assistant: {
            parts: [
              { type: "reasoning", text: "Inspect the inputs." },
              { type: "tool_call", toolCallId: "search-1" },
            ],
          },
        }),
        event(2, "2026-01-01T00:00:03.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "running",
              startedSeq: 0,
              startedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
        event(3, "2026-01-01T00:00:04.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "completed",
              startedSeq: 0,
              startedAt: "2026-01-01T00:00:00.000Z",
              output: { matches: 2 },
            },
          ],
        }),
      ]),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts[1]).toMatchObject({
      type: "tool_call",
      id: "search-1",
      startedTimestamp: Date.parse("2026-01-01T00:00:00.000Z"),
      status: "completed",
    });
    expect(groupTranscriptMessages(messages)[1]).toMatchObject({
      kind: "tool",
      timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
    });
  });

  it("replaces correlated tool facts with special lifecycle rows", () => {
    const entries = groupTranscriptMessages(
      conversationTranscriptMessages(
        conversation([
          event(1, "2026-01-01T00:00:01.000Z", {
            type: "subagent",
            startedSeq: 1,
            startedAt: "2026-01-01T00:00:01.000Z",
            childConversationId: "child-correlated",
            childKind: "task",
            subagentKind: "advisor",
            parentToolCallId: "advisor-correlated",
            status: "running",
          }),
          event(2, "2026-01-01T00:00:02.000Z", {
            type: "subagent",
            startedSeq: 1,
            startedAt: "2026-01-01T00:00:01.000Z",
            childConversationId: "child-correlated",
            childKind: "task",
            subagentKind: "advisor",
            parentToolCallId: "advisor-correlated",
            status: "completed",
          }),
          event(3, "2026-01-01T00:00:03.000Z", {
            type: "tool_calls",
            calls: [
              {
                toolCallId: "advisor-visible",
                name: "advisor",
                status: "running",
              },
            ],
          }),
          event(6, "2026-01-01T00:00:06.000Z", {
            type: "subagent",
            startedSeq: 6,
            startedAt: "2026-01-01T00:00:06.000Z",
            childConversationId: "child-legacy",
            childKind: "task",
            subagentKind: "advisor",
            status: "running",
          }),
          event(8, "2026-01-01T00:00:08.000Z", {
            type: "tool_calls",
            calls: [
              {
                toolCallId: "advisor-correlated",
                name: "advisor",
                status: "running",
                input: { task: "review" },
              },
            ],
          }),
          event(9, "2026-01-01T00:00:09.000Z", {
            type: "tool_calls",
            calls: [
              {
                toolCallId: "advisor-correlated",
                name: "advisor",
                status: "completed",
                output: { skill_name: "junior-qa" },
              },
            ],
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
      { kind: "subagent", name: undefined, status: "running" },
    ]);
  });

  it("projects failures, context changes, and correlated child conversations", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "compaction",
          summary: "Preserve the release checklist.",
        }),
        event(2, "2026-01-01T00:00:02.000Z", {
          type: "subagent",
          startedSeq: 2,
          startedAt: "2026-01-01T00:00:02.000Z",
          childConversationId: "child-1",
          childKind: "task",
          subagentKind: "advisor",
          status: "running",
        }),
        event(3, "2026-01-01T00:00:03.000Z", {
          type: "subagent",
          startedSeq: 2,
          startedAt: "2026-01-01T00:00:02.000Z",
          childConversationId: "child-1",
          childKind: "task",
          subagentKind: "advisor",
          status: "completed",
        }),
        event(4, "2026-01-01T00:00:04.000Z", {
          type: "turn_lifecycle",
          turnId: "turn-1",
          state: "failed",
          failureCode: "model_execution_failed",
        }),
      ]),
    );
    const entries = groupTranscriptMessages(messages);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "context",
      "subagent",
      "failure",
    ]);
    expect(entries[1]).toMatchObject({
      part: {
        childConversationId: "child-1",
        status: "completed",
      },
    });
    expect(messageRawText(messages[0]!)).toContain(
      "Preserve the release checklist.",
    );
  });

  it("attaches turn context without matching its hidden content", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "message",
          messageId: "user-1",
          role: "user",
          text: "Prepare the release.",
        }),
        event(1, "2026-01-01T00:00:01.000Z", {
          type: "turn_lifecycle",
          turnId: "turn-1",
          state: "started",
        }),
        event(2, "2026-01-01T00:00:02.000Z", {
          type: "turn_context",
          turnId: "turn-1",
          pluginName: "memory",
          kind: "recall",
          version: 1,
          content: {
            memories: [
              {
                id: "memory-1",
                content: "Release notes live in Notion.",
                observedAtMs: 1_750_000_000_000,
                scope: "conversation",
                kind: "knowledge",
              },
            ],
          },
        }),
      ]),
    );
    const entries = groupTranscriptMessages(messages);

    expect(messages[0]?.contexts).toHaveLength(1);
    expect(entryMatchesSearch(entries[0]!, "release notes")).toBe(false);
    expect(entryMatchesSearch(entries[0]!, "memory-1")).toBe(false);
  });

  it("correlates repeated child outcomes by start sequence", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        event(0, "2026-01-01T00:00:00.000Z", {
          type: "subagent",
          startedSeq: 0,
          startedAt: "2026-01-01T00:00:00.000Z",
          childConversationId: "child-1",
          childKind: "task",
          subagentKind: "advisor",
          status: "running",
        }),
        event(1, "2026-01-01T00:00:01.000Z", {
          type: "subagent",
          startedSeq: 1,
          startedAt: "2026-01-01T00:00:01.000Z",
          childConversationId: "child-1",
          childKind: "task",
          subagentKind: "advisor",
          status: "running",
        }),
        event(2, "2026-01-01T00:00:02.000Z", {
          type: "subagent",
          startedSeq: 1,
          startedAt: "2026-01-01T00:00:01.000Z",
          childConversationId: "child-1",
          childKind: "task",
          subagentKind: "advisor",
          status: "completed",
        }),
        event(3, "2026-01-01T00:00:03.000Z", {
          type: "subagent",
          startedSeq: 0,
          startedAt: "2026-01-01T00:00:00.000Z",
          childConversationId: "child-1",
          childKind: "task",
          subagentKind: "advisor",
          status: "error",
        }),
      ]),
    );

    expect(messages.map((message) => message.parts[0])).toMatchObject([
      { status: "error" },
      { status: "completed" },
    ]);
  });

  it("renders a completed subagent when its start is outside the page", () => {
    const ended = event(11, "2026-01-01T00:00:11.000Z", {
      type: "subagent",
      startedSeq: 5,
      startedAt: "2026-01-01T00:00:05.000Z",
      childConversationId: "child-before-page",
      childKind: "task",
      subagentKind: "advisor",
      parentToolCallId: "advisor-before-page",
      status: "completed",
    });
    const pageMessages = conversationTranscriptMessages(
      conversation([
        event(10, "2026-01-01T00:00:10.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "advisor-before-page",
              name: "advisor",
              status: "running",
            },
          ],
        }),
        ended,
      ]),
    );
    const fullMessages = conversationTranscriptMessages(
      conversation([
        event(5, "2026-01-01T00:00:05.000Z", {
          type: "subagent",
          startedSeq: 5,
          startedAt: "2026-01-01T00:00:05.000Z",
          childConversationId: "child-before-page",
          childKind: "task",
          subagentKind: "advisor",
          parentToolCallId: "advisor-before-page",
          status: "running",
        }),
        event(10, "2026-01-01T00:00:10.000Z", {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "advisor-before-page",
              name: "advisor",
              status: "running",
            },
          ],
        }),
        ended,
      ]),
    );

    expect(pageMessages).toHaveLength(1);
    expect(pageMessages[0]).toMatchObject({
      sourceSeq: 5,
      timestamp: Date.parse("2026-01-01T00:00:05.000Z"),
      parts: [
        {
          childConversationId: "child-before-page",
          status: "completed",
          subagentKind: "advisor",
          type: "subagent",
        },
      ],
    });
    expect(groupTranscriptMessages(pageMessages)[0]?.key).toBe(
      groupTranscriptMessages(fullMessages)[0]?.key,
    );
  });

  it("searches only message rows", () => {
    const entries = groupTranscriptMessages(
      conversationTranscriptMessages(
        conversation([
          event(0, "2026-01-01T00:00:00.000Z", {
            type: "tool_calls",
            calls: [
              {
                toolCallId: "search-1",
                name: "sentry.search",
                status: "running",
              },
            ],
          }),
          event(1, "2026-01-01T00:00:01.000Z", {
            type: "tool_calls",
            calls: [
              {
                toolCallId: "search-1",
                name: "sentry.search",
                status: "running",
                input: { project: "checkout-project" },
              },
            ],
          }),
          event(2, "2026-01-01T00:00:02.000Z", {
            type: "tool_calls",
            calls: [
              {
                toolCallId: "search-1",
                name: "sentry.search",
                status: "completed",
                output: { culprit: "payments-v42" },
              },
            ],
          }),
          event(3, "2026-01-01T00:00:03.000Z", {
            type: "subagent",
            startedSeq: 3,
            startedAt: "2026-01-01T00:00:03.000Z",
            childConversationId: "child-1",
            childKind: "task",
            subagentKind: "advisor",
            status: "running",
          }),
          event(4, "2026-01-01T00:00:04.000Z", {
            type: "compaction",
          }),
          event(6, "2026-01-01T00:00:06.000Z", {
            type: "turn_lifecycle",
            turnId: "turn-1",
            state: "failed",
            failureCode: "model_execution_failed",
          }),
          event(7, "2026-01-01T00:00:07.000Z", {
            type: "turn_lifecycle",
            turnId: "turn-2",
            state: "failed",
            failureCode: "delivery_failed",
          }),
        ]),
      ),
    );

    // Tool calls, child agents, compaction, and failures are activity, not
    // what people and Junior said.
    for (const query of [
      "sentry.search",
      "checkout-project",
      "payments-v42",
      "advisor",
      "compacted",
      "delivery failed",
    ]) {
      expect(entries.some((entry) => entryMatchesSearch(entry, query))).toBe(
        false,
      );
    }
  });

  it.each(["agent_invocation.completed", "agent.reply"])(
    "shows %s inputs only for the memories their Turn recalled",
    (eventType) => {
      const result = (seq: number, messageId: string) =>
        event(seq, "2026-01-01T00:00:05.000Z", {
          type: "message",
          messageId,
          role: "user",
          eventType,
          trustedSummary: 'Child agent "planner" finished its task.',
          text: "<agent-result>done</agent-result>",
        });
      const entries = groupTranscriptMessages(
        conversationTranscriptMessages(
          conversation([
            result(1, "result-quiet"),
            result(2, "result-recalled"),
            event(3, "2026-01-01T00:00:06.000Z", {
              type: "turn_lifecycle",
              turnId: "turn-recalled",
              state: "started",
              inputMessageIds: ["result-recalled"],
            }),
            event(4, "2026-01-01T00:00:07.000Z", {
              type: "turn_context",
              turnId: "turn-recalled",
              pluginName: "memory",
              kind: "recall",
              version: 1,
              content: {
                memories: [
                  {
                    id: "memory-1",
                    content: "Release notes live in Notion.",
                    observedAtMs: 1_750_000_000_000,
                    scope: "conversation",
                    kind: "knowledge",
                  },
                ],
              },
            }),
          ]),
        ),
      );

      expect(
        entries.map((entry) =>
          entry.kind === "message" ? entry.message.messageId : entry.kind,
        ),
      ).toEqual(["result-recalled"]);
    },
  );
});
