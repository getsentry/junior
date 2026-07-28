import { describe, expect, it } from "vitest";
import {
  agentTurnCostUsd,
  enforceTurnSpendLimit,
  TurnSpendCostUnavailableError,
  TurnSpendLimitExceededError,
} from "@/chat/services/spend-limit";
import { addAgentTurnUsage } from "@/chat/usage";

describe("turn spend limit", () => {
  it("uses the provider total when present", () => {
    expect(
      agentTurnCostUsd({
        cost: { input: 1, output: 2, total: 2.5 },
      }),
    ).toBe(2.5);
  });

  it("derives cost from components when total is absent", () => {
    expect(
      agentTurnCostUsd({
        cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 },
      }),
    ).toBe(3.75);
  });

  it("allows spend below the cap", () => {
    expect(() =>
      enforceTurnSpendLimit({
        maxSpendUsd: 1,
        usage: { cost: { total: 0.99 } },
      }),
    ).not.toThrow();
  });

  it("hard-stops when spend reaches the cap", () => {
    expect(() =>
      enforceTurnSpendLimit({
        maxSpendUsd: 1,
        usage: { cost: { total: 1 } },
      }),
    ).toThrow(TurnSpendLimitExceededError);
  });

  it("counts total-only and component-only usage together", () => {
    expect(() =>
      enforceTurnSpendLimit({
        maxSpendUsd: 1,
        usage: addAgentTurnUsage(
          { cost: { total: 0.75 } },
          { cost: { input: 0.15, output: 0.1 } },
        ),
      }),
    ).toThrow(TurnSpendLimitExceededError);
  });

  it("hard-stops when provider usage omits cost data", () => {
    expect(() =>
      enforceTurnSpendLimit({
        maxSpendUsd: 1,
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    ).toThrow(TurnSpendCostUnavailableError);
  });

  it("allows an empty turn before provider usage exists", () => {
    expect(() =>
      enforceTurnSpendLimit({
        maxSpendUsd: 1,
        usage: undefined,
      }),
    ).not.toThrow();
  });

  it("is disabled without a configured cap", () => {
    expect(() =>
      enforceTurnSpendLimit({
        maxSpendUsd: undefined,
        usage: { cost: { total: 10 } },
      }),
    ).not.toThrow();
  });
});
