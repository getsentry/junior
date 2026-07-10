import { describe, expect, it } from "vitest";
import {
  extractGenAiUsageAttributes,
  extractGenAiUsageSummary,
} from "@/chat/logging";

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
        reasoning: 12,
        totalTokens: 1125,
        cost: {
          input: 0.001,
          output: 0.002,
          cacheRead: 0.0003,
          cacheWrite: 0.0004,
          total: 0.0037,
        },
      },
    };

    expect(extractGenAiUsageSummary(assistantMessage)).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cachedInputTokens: 900,
      cacheCreationTokens: 60,
      reasoningTokens: 12,
      totalTokens: 1125,
      cost: {
        input: 0.001,
        output: 0.002,
        cacheRead: 0.0003,
        cacheWrite: 0.0004,
        total: 0.0037,
      },
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

  it("maps cache token counters to current GenAI semantic attributes", () => {
    expect(
      extractGenAiUsageAttributes({
        inputTokens: 10,
        outputTokens: 2,
        cachedInputTokens: 4,
        cacheCreationTokens: 1,
        reasoningTokens: 1,
        cost: {
          input: 0.001,
          output: 0.002,
          cacheRead: 0.0003,
          cacheWrite: 0.0004,
          total: 0.0037,
        },
      }),
    ).toEqual({
      "gen_ai.usage.input_tokens": 15,
      "gen_ai.usage.output_tokens": 2,
      "gen_ai.usage.total_tokens": 17,
      "gen_ai.usage.input_tokens.cached": 4,
      "gen_ai.usage.input_tokens.cache_write": 1,
      "app.ai.reasoning_tokens": 1,
      "app.ai.cost.input_usd": 0.001,
      "app.ai.cost.output_usd": 0.002,
      "app.ai.cost.cache_read_usd": 0.0003,
      "app.ai.cost.cache_write_usd": 0.0004,
      "app.ai.cost.total_usd": 0.0037,
    });
  });
});
