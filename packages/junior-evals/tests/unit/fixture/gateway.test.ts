import { describe, expect, it } from "vitest";
import { readGatewayMessageUsage } from "../../../src/fixture/gateway";

describe("AI Gateway usage", () => {
  it("keeps numeric usage across stream events without retaining content", () => {
    const body = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 20,
          },
        },
      },
      { type: "content_block_delta", delta: { text: "private reply" } },
      { type: "message_delta", usage: { output_tokens: 5 } },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");

    const result = readGatewayMessageUsage(body, "openai/gpt-6-luna");
    expect(result).toMatchObject({
      modelId: "openai/gpt-6-luna",
      inputTokens: 10,
      cachedInputTokens: 100,
      cacheCreationTokens: 20,
      outputTokens: 5,
    });
    expect(result.costUsd?.total).toBeCloseTo(0.000007, 10);
    expect(JSON.stringify(result)).not.toContain("private reply");
  });

  it("does not turn missing cache counters into zero or price an unknown model", () => {
    const body =
      'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n';
    expect(readGatewayMessageUsage(body, "unknown/model")).toEqual({
      modelId: "unknown/model",
      inputTokens: 12,
    });
  });
});
