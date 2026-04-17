import { describe, expect, it } from "vitest";
import { extractGenAiUsageSummary } from "@/chat/logging";

describe("extractGenAiUsageSummary", () => {
  it("returns empty object for sources with no usage metadata", () => {
    expect(extractGenAiUsageSummary({}, undefined, null)).toEqual({});
  });

  it("captures the pi-ai AssistantMessage.usage shape", () => {
    const assistantMessage = {
      role: "assistant",
      usage: {
        input: 120,
        output: 45,
        cacheRead: 900,
        cacheWrite: 60,
        totalTokens: 1125,
      },
    };

    expect(extractGenAiUsageSummary(assistantMessage)).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cachedInputTokens: 900,
      cacheCreationTokens: 60,
      totalTokens: 1125,
    });
  });

  it("accepts a bare pi-ai Usage record as a source", () => {
    expect(
      extractGenAiUsageSummary({
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 15,
    });
  });

  it("sums usage across multiple sources (multi-message turn)", () => {
    const firstCall = {
      usage: {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 0,
        totalTokens: 160,
      },
    };
    const secondCall = {
      usage: {
        input: 200,
        output: 30,
        cacheRead: 5,
        cacheWrite: 0,
        totalTokens: 235,
      },
    };

    expect(extractGenAiUsageSummary(firstCall, secondCall)).toEqual({
      inputTokens: 300,
      outputTokens: 80,
      cachedInputTokens: 15,
      cacheCreationTokens: 0,
      totalTokens: 395,
    });
  });

  it("ignores sources without a usage record while summing the rest", () => {
    const emptyAgentState = { messages: [] };
    const assistantMessage = {
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
      },
    };

    expect(
      extractGenAiUsageSummary(undefined, emptyAgentState, assistantMessage),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 12,
    });
  });
});
