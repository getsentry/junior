import { describe, expect, it } from "vitest";
import {
  agentTurnCostUsd,
  enforceTurnSpendLimit,
  TurnSpendLimitExceededError,
} from "@/chat/services/spend-limit";

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

  it("is disabled without a configured cap", () => {
    expect(() =>
      enforceTurnSpendLimit({
        maxSpendUsd: undefined,
        usage: { cost: { total: 10 } },
      }),
    ).not.toThrow();
  });
});
