import { describe, expect, it } from "vitest";
import {
  addAgentTurnUsage,
  agentTurnCostUsd,
  hasAgentTurnUsage,
} from "@/chat/usage";

describe("addAgentTurnUsage", () => {
  it("preserves component counters when all slices report components", () => {
    expect(
      addAgentTurnUsage(
        { inputTokens: 10, outputTokens: 3 },
        { outputTokens: 7, cachedInputTokens: 2 },
      ),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 10,
      cachedInputTokens: 2,
    });
  });

  it("aggregates reasoning and Pi cost metadata across slices", () => {
    expect(
      addAgentTurnUsage(
        {
          inputTokens: 10,
          outputTokens: 3,
          reasoningTokens: 2,
          cost: {
            input: 0.001,
            output: 0.002,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.003,
          },
        },
        {
          outputTokens: 7,
          reasoningTokens: 4,
          cost: {
            input: 0.004,
            output: 0.005,
            cacheRead: 0.0001,
            cacheWrite: 0.0002,
            total: 0.0093,
          },
        },
      ),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 10,
      reasoningTokens: 6,
      cost: {
        input: 0.005,
        output: 0.007,
        cacheRead: 0.0001,
        cacheWrite: 0.0002,
        total: 0.0123,
      },
    });
  });

  it("recognizes cost-only usage records", () => {
    expect(hasAgentTurnUsage({ cost: { total: 0.01 } })).toBe(true);
  });

  it("reads estimated total cost from usage records", () => {
    expect(agentTurnCostUsd({ cost: { total: 0.42 } })).toBe(0.42);
    expect(
      agentTurnCostUsd({
        cost: { input: 0.1, output: 0.08, cacheRead: 0.01, cacheWrite: 0.01 },
      }),
    ).toBe(0.2);
    expect(agentTurnCostUsd({ totalTokens: 10 })).toBeUndefined();
  });

  it("uses provider totals only for slices without component counters", () => {
    expect(
      addAgentTurnUsage(
        { totalTokens: 1_000 },
        { outputTokens: 7 },
        { inputTokens: 2, outputTokens: 3, totalTokens: 999 },
      ),
    ).toEqual({
      totalTokens: 1_012,
    });
  });
});
