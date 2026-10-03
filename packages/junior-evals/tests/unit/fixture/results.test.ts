import { describe, expect, it } from "vitest";
import { conversationReportEventSchema } from "@/api/schema/conversation";
import { readModelCalls, readModelTotals } from "../../../src/fixture/results";

describe("model call usage", () => {
  it("keeps only new, privacy-safe call metrics and preserves missing counters", () => {
    const assistant = (seq: number, usage?: Record<string, unknown>) =>
      conversationReportEventSchema.parse({
        seq,
        createdAt: "2026-10-03T12:00:00.000Z",
        data: {
          type: "assistant_message",
          parts: [{ type: "reasoning", text: "private model content" }],
        },
        model: {
          modelId: "anthropic/claude-opus-5.5",
          modelProfile: "handoff",
        },
        modelCall: {
          provider: "anthropic",
          ...(usage ? { usage } : undefined),
        },
      });
    const calls = readModelCalls(
      [
        assistant(1, { inputTokens: 10, cachedInputTokens: 5 }),
        assistant(2, {
          inputTokens: 0,
          outputTokens: 12,
          cachedInputTokens: 90,
          cacheCreationTokens: 20,
          cost: {
            input: 0,
            cacheRead: 0.000018,
            cacheWrite: 0.0001,
            total: 0.000118,
          },
        }),
        assistant(3),
      ],
      1,
    );

    expect(calls).toEqual([
      {
        eventSeq: 2,
        modelId: "anthropic/claude-opus-5.5",
        modelProfile: "handoff",
        inputTokens: 0,
        outputTokens: 12,
        cachedInputTokens: 90,
        cacheCreationTokens: 20,
        costUsd: {
          input: 0,
          cacheRead: 0.000018,
          cacheWrite: 0.0001,
          total: 0.000118,
        },
      },
      {
        eventSeq: 3,
        modelId: "anthropic/claude-opus-5.5",
        modelProfile: "handoff",
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("private model content");
  });

  it("includes model totals when costs have no agent-history event", () => {
    expect(
      readModelTotals([
        {
          modelId: "openai/gpt-6-luna",
          usage: {
            inputTokens: 4,
            cachedInputTokens: 100,
            cacheCreationTokens: 10,
            cost: { cacheRead: 0.00002, cacheWrite: 0.0001, total: 0.00012 },
          },
        },
      ]),
    ).toEqual([
      {
        modelId: "openai/gpt-6-luna",
        inputTokens: 4,
        cachedInputTokens: 100,
        cacheCreationTokens: 10,
        costUsd: { cacheRead: 0.00002, cacheWrite: 0.0001, total: 0.00012 },
      },
    ]);
  });
});
