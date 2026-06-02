import { describe, expect, it } from "vitest";

import {
  groupTranscriptMessages,
  groupTranscriptParts,
} from "../src/client/components/transcriptRenderModel";
import type { TranscriptMessage } from "../src/client/types";

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
});
