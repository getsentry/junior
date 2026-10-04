import { describe, expect, it } from "vitest";
import { contextProvenance } from "@/chat/conversations/provenance";
import {
  pendingSegments,
  type HistoryEntry,
} from "@/chat/distillation/history";
import type { PiMessage } from "@/chat/pi/messages";

function entry(message: PiMessage, seq: number): HistoryEntry {
  return { message, provenance: contextProvenance, seq };
}

describe("Conversation observation boundaries", () => {
  it("keeps parallel tool calls with both results and leaves the recent answer raw", () => {
    const entries = [
      entry(
        {
          role: "user",
          content: "Check two files.",
          timestamp: 1,
        } as PiMessage,
        1,
      ),
      entry(
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "read-a",
              name: "readFile",
              arguments: { path: "a" },
            },
            {
              type: "toolCall",
              id: "read-b",
              name: "readFile",
              arguments: { path: "b" },
            },
          ],
          api: "anthropic-messages",
          provider: "vercel-ai-gateway",
          model: "openai/gpt-6-luna",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "toolUse",
          timestamp: 2,
        },
        2,
      ),
      entry(
        {
          role: "toolResult",
          toolCallId: "read-a",
          toolName: "readFile",
          content: [{ type: "text", text: "a".repeat(55_000) }],
          isError: false,
          timestamp: 3,
        } as PiMessage,
        3,
      ),
      entry(
        {
          role: "toolResult",
          toolCallId: "read-b",
          toolName: "readFile",
          content: [{ type: "text", text: "done" }],
          isError: false,
          timestamp: 4,
        } as PiMessage,
        4,
      ),
      entry(
        {
          role: "assistant",
          content: [{ type: "text", text: "recent".repeat(20_000) }],
          timestamp: 5,
        } as PiMessage,
        5,
      ),
    ];
    const segments = pendingSegments({
      entries,
      events: [],
      historyVersion: 0,
      terminalSeq: 6,
    });
    expect(segments.map((segment) => segment.map((item) => item.seq))).toEqual([
      [1, 2, 3, 4],
    ]);
  });

  it("does not cover a tool group that exceeds one observation segment", () => {
    const entries = [
      entry({ role: "user", content: "Read both.", timestamp: 1 }, 1),
      entry(
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "read-a",
              name: "readFile",
              arguments: { path: "a" },
            },
            {
              type: "toolCall",
              id: "read-b",
              name: "readFile",
              arguments: { path: "b" },
            },
          ],
          api: "anthropic-messages",
          provider: "vercel-ai-gateway",
          model: "openai/gpt-6-luna",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "toolUse",
          timestamp: 2,
        },
        2,
      ),
      entry(
        {
          role: "toolResult",
          toolCallId: "read-a",
          toolName: "readFile",
          content: [{ type: "text", text: "a".repeat(36_000) }],
          isError: false,
          timestamp: 3,
        },
        3,
      ),
      entry(
        {
          role: "toolResult",
          toolCallId: "read-b",
          toolName: "readFile",
          content: [{ type: "text", text: "b".repeat(36_000) }],
          isError: false,
          timestamp: 4,
        },
        4,
      ),
      entry(
        {
          role: "user",
          content: "recent".repeat(20_000),
          timestamp: 5,
        },
        5,
      ),
    ];
    expect(
      pendingSegments({
        entries,
        events: [],
        historyVersion: 0,
        terminalSeq: 6,
      }),
    ).toEqual([]);
  });
});
