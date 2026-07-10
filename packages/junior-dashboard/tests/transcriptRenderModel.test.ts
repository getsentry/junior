import { describe, expect, it } from "vitest";

import {
  groupTranscriptMessages,
  groupTranscriptParts,
} from "../src/client/components/transcriptRenderModel";
import { turnHasMatch } from "../src/client/components/transcriptSearch";
import { turnTranscriptMessages } from "../src/client/transcriptActivity";
import type { ConversationTurn, TranscriptMessage } from "../src/client/types";

function conversationTurn(
  overrides: Partial<ConversationTurn>,
): ConversationTurn {
  return {
    conversationId: "conversation-1",
    cumulativeDurationMs: 0,
    displayTitle: "Conversation",
    id: "turn-1",
    lastProgressAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    surface: "internal",
    transcript: [],
    transcriptAvailable: true,
    ...overrides,
  };
}

describe("transcript render model", () => {
  it("promotes thinking parts to standalone transcript events", () => {
    const messages = [
      {
        role: "assistant",
        timestamp: 1_000,
        parts: [
          { type: "text", text: "first" },
          { type: "thinking", output: "inspect the inputs" },
          { type: "text", text: "second" },
        ],
      },
    ] as TranscriptMessage[];

    expect(groupTranscriptMessages(messages)).toEqual([
      {
        kind: "message",
        message: {
          role: "assistant",
          timestamp: 1_000,
          parts: [{ type: "text", text: "first" }],
        },
      },
      {
        kind: "thinking",
        part: { type: "thinking", output: "inspect the inputs" },
        timestamp: 1_000,
      },
      {
        kind: "message",
        message: {
          role: "assistant",
          timestamp: 1_000,
          parts: [{ type: "text", text: "second" }],
        },
      },
    ]);
  });

  it("matches tool results by id before falling back to tool name", () => {
    const messages = [
      {
        role: "assistant",
        timestamp: 1_000,
        parts: [{ type: "tool_call", id: "call-1", name: "search" }],
      },
      {
        role: "assistant",
        timestamp: 1_100,
        parts: [{ type: "tool_call", id: "call-2", name: "search" }],
      },
      {
        role: "toolResult",
        timestamp: 2_000,
        parts: [{ type: "tool_result", id: "call-2", name: "search" }],
      },
    ] as TranscriptMessage[];

    expect(groupTranscriptMessages(messages)).toEqual([
      {
        call: { type: "tool_call", id: "call-1", name: "search" },
        kind: "tool",
        timestamp: 1_000,
      },
      {
        call: { type: "tool_call", id: "call-2", name: "search" },
        kind: "tool",
        result: { type: "tool_result", id: "call-2", name: "search" },
        resultTimestamp: 2_000,
        timestamp: 1_100,
      },
    ]);
  });

  it("does not group inline same-name tool parts with mismatched ids", () => {
    expect(
      groupTranscriptParts([
        { type: "tool_call", id: "call-1", name: "search" },
        { type: "tool_result", id: "call-2", name: "search" },
      ]),
    ).toEqual([
      {
        call: { type: "tool_call", id: "call-1", name: "search" },
        kind: "tool",
      },
      {
        kind: "tool",
        result: { type: "tool_result", id: "call-2", name: "search" },
      },
    ]);
  });

  it("backfills activity tool calls so result-only transcript entries are paired", () => {
    const turn = conversationTurn({
      activity: [
        {
          type: "tool_execution",
          id: "call-1",
          toolCallId: "call-1",
          toolName: "search",
          createdAt: "2026-01-01T00:00:01.000Z",
          status: "completed",
          args: { query: "activity" },
          subagents: [],
        },
      ],
      transcript: [
        {
          role: "toolResult",
          timestamp: Date.parse("2026-01-01T00:00:02.000Z"),
          parts: [{ type: "tool_result", id: "call-1", name: "search" }],
        },
      ],
      transcriptAvailable: true,
    });

    expect(groupTranscriptMessages(turnTranscriptMessages(turn))).toEqual([
      {
        call: {
          type: "tool_call",
          id: "call-1",
          name: "search",
          status: "completed",
          input: { query: "activity" },
        },
        kind: "tool",
        result: { type: "tool_result", id: "call-1", name: "search" },
        resultTimestamp: Date.parse("2026-01-01T00:00:02.000Z"),
        timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
      },
    ]);
  });

  it("preserves transcript order when activity rows have inverted tool timestamps", () => {
    const turn = conversationTurn({
      activity: [
        {
          type: "tool_execution",
          id: "call-1",
          toolCallId: "call-1",
          toolName: "search",
          createdAt: "2026-01-01T00:00:01.000Z",
          status: "completed",
          subagents: [],
        },
      ],
      transcript: [
        {
          role: "assistant",
          timestamp: Date.parse("2026-01-01T00:00:02.000Z"),
          parts: [{ type: "tool_call", id: "call-1", name: "search" }],
        },
        {
          role: "toolResult",
          timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
          parts: [{ type: "tool_result", id: "call-1", name: "search" }],
        },
      ],
      transcriptAvailable: true,
    });

    expect(groupTranscriptMessages(turnTranscriptMessages(turn))).toEqual([
      {
        call: {
          type: "tool_call",
          id: "call-1",
          name: "search",
          status: "completed",
        },
        kind: "tool",
        result: { type: "tool_result", id: "call-1", name: "search" },
        resultTimestamp: Date.parse("2026-01-01T00:00:01.000Z"),
        timestamp: Date.parse("2026-01-01T00:00:02.000Z"),
      },
    ]);
  });

  it("adds subagent activity as transcript entries", () => {
    const turn = conversationTurn({
      activity: [
        {
          type: "tool_execution",
          id: "advisor-call",
          toolCallId: "advisor-call",
          toolName: "advisor",
          createdAt: "2026-01-01T00:00:01.000Z",
          status: "running",
          subagents: [
            {
              type: "subagent",
              id: "advisor-call",
              subagentKind: "advisor",
              parentToolCallId: "advisor-call",
              createdAt: "2026-01-01T00:00:02.000Z",
              status: "running",
            },
            {
              type: "subagent",
              id: "advisor-call-2",
              subagentKind: "advisor",
              parentToolCallId: "advisor-call",
              createdAt: "2026-01-01T00:00:03.000Z",
              status: "completed",
              outcome: "success",
            },
          ],
        },
      ],
      transcript: [],
      transcriptAvailable: true,
    });

    expect(groupTranscriptMessages(turnTranscriptMessages(turn))).toEqual([
      {
        call: {
          type: "tool_call",
          id: "advisor-call",
          name: "advisor",
          status: "running",
        },
        kind: "tool",
        timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
      },
      {
        kind: "subagent",
        part: {
          type: "subagent",
          id: "advisor-call",
          subagentKind: "advisor",
          parentToolCallId: "advisor-call",
          status: "running",
        },
        timestamp: Date.parse("2026-01-01T00:00:02.000Z"),
      },
      {
        kind: "subagent",
        part: {
          type: "subagent",
          id: "advisor-call-2",
          subagentKind: "advisor",
          parentToolCallId: "advisor-call",
          status: "completed",
          outcome: "success",
        },
        timestamp: Date.parse("2026-01-01T00:00:03.000Z"),
      },
    ]);
  });

  it("does not duplicate subagents from repeated activity snapshots", () => {
    const turn = conversationTurn({
      activity: [
        {
          type: "tool_execution",
          id: "advisor-call",
          toolCallId: "advisor-call",
          toolName: "advisor",
          createdAt: "2026-01-01T00:00:01.000Z",
          status: "running",
          subagents: [
            {
              type: "subagent",
              id: "advisor-subagent",
              subagentKind: "advisor",
              parentToolCallId: "advisor-call",
              createdAt: "2026-01-01T00:00:02.000Z",
              status: "running",
            },
          ],
        },
        {
          type: "tool_execution",
          id: "advisor-call",
          toolCallId: "advisor-call",
          toolName: "advisor",
          createdAt: "2026-01-01T00:00:01.000Z",
          status: "running",
          subagents: [
            {
              type: "subagent",
              id: "advisor-subagent",
              subagentKind: "advisor",
              parentToolCallId: "advisor-call",
              createdAt: "2026-01-01T00:00:02.000Z",
              status: "running",
            },
          ],
        },
      ],
      transcript: [],
      transcriptAvailable: true,
    });

    expect(groupTranscriptMessages(turnTranscriptMessages(turn))).toEqual([
      {
        call: {
          type: "tool_call",
          id: "advisor-call",
          name: "advisor",
          status: "running",
        },
        kind: "tool",
        timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
      },
      {
        kind: "subagent",
        part: {
          type: "subagent",
          id: "advisor-subagent",
          subagentKind: "advisor",
          parentToolCallId: "advisor-call",
          status: "running",
        },
        timestamp: Date.parse("2026-01-01T00:00:02.000Z"),
      },
    ]);
  });

  it("keeps subagent activity between an existing tool call and result", () => {
    const turn = conversationTurn({
      activity: [
        {
          type: "tool_execution",
          id: "advisor-call",
          toolCallId: "advisor-call",
          toolName: "advisor",
          createdAt: "2026-01-01T00:00:01.000Z",
          status: "completed",
          subagents: [
            {
              type: "subagent",
              id: "advisor-subagent",
              subagentKind: "advisor",
              parentToolCallId: "advisor-call",
              createdAt: "2026-01-01T00:00:02.000Z",
              status: "completed",
              outcome: "success",
            },
          ],
        },
      ],
      transcript: [
        {
          role: "assistant",
          timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
          parts: [{ type: "tool_call", id: "advisor-call", name: "advisor" }],
        },
        {
          role: "toolResult",
          timestamp: Date.parse("2026-01-01T00:00:03.000Z"),
          parts: [{ type: "tool_result", id: "advisor-call", name: "advisor" }],
        },
      ],
      transcriptAvailable: true,
    });

    expect(groupTranscriptMessages(turnTranscriptMessages(turn))).toEqual([
      {
        call: {
          type: "tool_call",
          id: "advisor-call",
          name: "advisor",
          status: "completed",
        },
        kind: "tool",
        result: {
          type: "tool_result",
          id: "advisor-call",
          name: "advisor",
        },
        resultTimestamp: Date.parse("2026-01-01T00:00:03.000Z"),
        timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
      },
      {
        kind: "subagent",
        part: {
          type: "subagent",
          id: "advisor-subagent",
          subagentKind: "advisor",
          parentToolCallId: "advisor-call",
          status: "completed",
          outcome: "success",
        },
        timestamp: Date.parse("2026-01-01T00:00:02.000Z"),
      },
    ]);
  });

  it("leaves ambiguous name-only tool results unpaired", () => {
    const messages = [
      {
        role: "assistant",
        timestamp: 1_000,
        parts: [{ type: "tool_call", name: "search" }],
      },
      {
        role: "assistant",
        timestamp: 1_100,
        parts: [{ type: "tool_call", name: "search" }],
      },
      {
        role: "toolResult",
        timestamp: 2_000,
        parts: [{ type: "tool_result", name: "search" }],
      },
    ] as TranscriptMessage[];

    expect(groupTranscriptMessages(messages)).toEqual([
      {
        call: { type: "tool_call", name: "search" },
        kind: "tool",
        timestamp: 1_000,
      },
      {
        call: { type: "tool_call", name: "search" },
        kind: "tool",
        timestamp: 1_100,
      },
      {
        kind: "tool",
        result: { type: "tool_result", name: "search" },
        resultTimestamp: 2_000,
      },
    ]);
  });

  it("does not pair name-only results across message boundaries", () => {
    const messages = [
      {
        role: "assistant",
        timestamp: 1_000,
        parts: [{ type: "tool_call", name: "search" }],
      },
      {
        role: "assistant",
        timestamp: 1_500,
        parts: [{ type: "text", text: "Continuing after the search." }],
      },
      {
        role: "toolResult",
        timestamp: 2_000,
        parts: [{ type: "tool_result", name: "search" }],
      },
    ] as TranscriptMessage[];

    expect(groupTranscriptMessages(messages)).toEqual([
      {
        call: { type: "tool_call", name: "search" },
        kind: "tool",
        timestamp: 1_000,
      },
      {
        kind: "message",
        message: {
          role: "assistant",
          timestamp: 1_500,
          parts: [{ type: "text", text: "Continuing after the search." }],
        },
      },
      {
        kind: "tool",
        result: { type: "tool_result", name: "search" },
        resultTimestamp: 2_000,
      },
    ]);
  });

  it("pairs one name-only call across thinking activity", () => {
    const messages = [
      {
        role: "assistant",
        timestamp: 1_000,
        parts: [{ type: "tool_call", name: "search" }],
      },
      {
        role: "assistant",
        timestamp: 1_500,
        parts: [{ type: "thinking", output: "Waiting for search." }],
      },
      {
        role: "toolResult",
        timestamp: 2_000,
        parts: [{ type: "tool_result", name: "search" }],
      },
    ] as TranscriptMessage[];

    expect(groupTranscriptMessages(messages)).toEqual([
      {
        call: { type: "tool_call", name: "search" },
        kind: "tool",
        result: { type: "tool_result", name: "search" },
        resultTimestamp: 2_000,
        timestamp: 1_000,
      },
      {
        kind: "thinking",
        part: { type: "thinking", output: "Waiting for search." },
        timestamp: 1_500,
      },
    ]);
  });

  it("treats mixed ID metadata as ambiguous for name-only results", () => {
    const messages = [
      {
        role: "assistant",
        timestamp: 1_000,
        parts: [{ type: "tool_call", name: "search" }],
      },
      {
        role: "assistant",
        timestamp: 1_100,
        parts: [{ type: "tool_call", id: "call-2", name: "search" }],
      },
      {
        role: "toolResult",
        timestamp: 2_000,
        parts: [{ type: "tool_result", name: "search" }],
      },
    ] as TranscriptMessage[];

    expect(groupTranscriptMessages(messages).at(-1)).toEqual({
      kind: "tool",
      result: { type: "tool_result", name: "search" },
      resultTimestamp: 2_000,
    });
  });

  it("matches derived activity rows in transcript search", () => {
    const turn = conversationTurn({
      activity: [
        {
          type: "tool_execution",
          id: "advisor-call",
          toolCallId: "advisor-call",
          toolName: "advisor",
          createdAt: "2026-01-01T00:00:01.000Z",
          status: "running",
          subagents: [
            {
              type: "subagent",
              id: "advisor-call",
              subagentKind: "advisor",
              parentToolCallId: "advisor-call",
              createdAt: "2026-01-01T00:00:02.000Z",
              status: "running",
            },
          ],
        },
      ],
      transcript: [],
      transcriptAvailable: true,
    });

    expect(turnHasMatch(turn, "advisor")).toBe(true);
    expect(turnHasMatch(turn, "running")).toBe(true);
    expect(turnHasMatch(turn, "not-present")).toBe(false);
  });

  it("matches tool activity status in transcript search", () => {
    const turn = conversationTurn({
      activity: [
        {
          type: "tool_execution",
          id: "call-running",
          toolCallId: "call-running",
          toolName: "search",
          createdAt: "2026-01-01T00:00:01.000Z",
          status: "running",
          subagents: [],
        },
      ],
      transcript: [],
      transcriptAvailable: true,
    });

    expect(turnHasMatch(turn, "running")).toBe(true);
  });
});
