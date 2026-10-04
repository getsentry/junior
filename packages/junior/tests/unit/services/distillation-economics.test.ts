import { describe, expect, it } from "vitest";
import { resolveGatewayModel } from "@/chat/pi/client";
import {
  distillationSavings,
  shouldUseDistillations,
} from "@/chat/distillation/economics";

const model = resolveGatewayModel("anthropic/claude-opus-5.5");

describe("priced Conversation distillation", () => {
  it("leaves a warm prefix alone when a replacement write exceeds the future reads it saves", () => {
    expect(
      shouldUseDistillations({
        model,
        rawTokens: 80_000,
        replacementTokens: 20_000,
        expectedCalls: 2,
        rawCacheWarm: true,
        workerCostUsd: 0.01,
      }),
    ).toBe(false);
  });

  it("switches only when priced cache reads repay the new write and worker", () => {
    const args = {
      model,
      rawTokens: 200_000,
      replacementTokens: 20_000,
      expectedCalls: 10,
      rawCacheWarm: true,
      workerCostUsd: 0.02,
    };
    expect(distillationSavings(args)?.savingsRatio).toBeGreaterThan(0.2);
    expect(shouldUseDistillations(args)).toBe(true);
    expect(shouldUseDistillations({ ...args, workerCostUsd: 10 })).toBe(false);
  });
});
