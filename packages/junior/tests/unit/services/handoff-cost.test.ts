import { describe, expect, it } from "vitest";
import { resolveGatewayModel } from "@/chat/pi/client";
import { shouldReuseHandoffHistory } from "@/chat/services/handoff-cost";

const fastModel = resolveGatewayModel("openai/gpt-6-luna");
const targetModel = resolveGatewayModel("anthropic/claude-opus-5.5");

describe("handoff cost", () => {
  it("keeps a short raw history when a summary cannot repay its call and cache write", () => {
    expect(
      shouldReuseHandoffHistory({
        fastModel,
        targetModel,
        rawTokens: 1_000,
        replacementTokens: 2_000,
        summaryInputTokens: 1_000,
        summaryOutputTokens: 1_500,
      }),
    ).toBe(true);
  });

  it("summarizes when the target model's cold write and next read save more than 20 percent", () => {
    expect(
      shouldReuseHandoffHistory({
        fastModel,
        targetModel,
        rawTokens: 100_000,
        replacementTokens: 5_000,
        summaryInputTokens: 100_000,
        summaryOutputTokens: 1_500,
      }),
    ).toBe(false);
  });
});
