import { describe, expect, it } from "vitest";
import { addAgentTurnUsage } from "@/chat/usage";

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
