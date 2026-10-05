import { describe, expect, it } from "vitest";
import { contextProvenance } from "@/chat/conversations/provenance";
import {
  estimateWorkerCost,
  shouldUseDistillations,
} from "@/chat/distillation/economics";
import {
  estimateModelVisibleTokens,
  pendingSegments,
  renderSegment,
  type HistoryEntry,
} from "@/chat/distillation/history";
import { resolveGatewayModel } from "@/chat/pi/client";
import { piMessageSchema, type PiMessage } from "@/chat/pi/messages";

function entry(message: PiMessage, seq: number): HistoryEntry {
  return { message, provenance: contextProvenance, seq };
}

describe("Conversation observation boundaries", () => {
  it("covers enough safe history to make one completed Opus Turn worth replacing", () => {
    const prior = Array.from({ length: 11 }, (_, index) =>
      entry(
        {
          role: "assistant",
          content: [{ type: "text", text: "a".repeat(60_000) }],
          timestamp: index + 1,
        } as PiMessage,
        index + 1,
      ),
    );
    const entries = [
      ...prior,
      entry(
        { role: "user", content: "recent".repeat(14_000), timestamp: 12 },
        12,
      ),
    ];
    const segments = pendingSegments({
      entries,
      events: [],
      historyVersion: 0,
      terminalSeq: 13,
    });
    const covered = segments.flat();
    const rawTokens = estimateModelVisibleTokens(
      entries.map((item) => item.message),
    );
    const coveredTokens = estimateModelVisibleTokens(
      covered.map((item) => item.message),
    );
    const observationTokens = segments.length * 2_048;

    expect(covered.map((item) => item.seq)).toEqual(
      prior.map((item) => item.seq),
    );
    expect(
      shouldUseDistillations({
        model: resolveGatewayModel("anthropic/claude-opus-5.5"),
        rawTokens,
        replacementTokens: rawTokens - coveredTokens + observationTokens,
        expectedCalls: 12,
        rawCacheWarm: true,
        workerCostUsd: estimateWorkerCost({
          model: resolveGatewayModel("openai/gpt-6-luna"),
          inputTokens: coveredTokens,
          outputTokens: observationTokens,
        }),
      }),
    ).toBe(true);
  });

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
    const observed = renderSegment(segments[0]!);
    expect(observed).toContain("Called readFile (read-a)");
    expect(observed).toContain("tool result (readFile, call read-a)");
    expect(observed).toContain("Called readFile (read-b)");
    expect(observed).toContain("tool result (readFile, call read-b)");
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

  it("leaves unreadable assistant content raw instead of marking it covered", () => {
    const opaque = entry(
      piMessageSchema.parse({
        role: "assistant",
        content: [{ type: "redacted_thinking", text: "not visible" }],
        timestamp: 2,
      }),
      2,
    );
    expect(
      pendingSegments({
        entries: [
          entry({ role: "user", content: "Earlier work", timestamp: 1 }, 1),
          opaque,
          entry(
            { role: "user", content: "Recent".repeat(30_000), timestamp: 3 },
            3,
          ),
        ],
        events: [],
        historyVersion: 0,
        terminalSeq: 4,
      }),
    ).toEqual([]);
    expect(() => renderSegment([opaque])).toThrow(
      "Cannot render an unreadable observation entry",
    );
  });
});
