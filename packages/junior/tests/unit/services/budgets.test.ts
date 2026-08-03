import { describe, expect, it } from "vitest";
import {
  BudgetExceededError,
  buildBudgetExceededResponse,
  checkBudgets,
  describeBudgets,
  getBudgetAttributes,
  isBudgetExceededError,
  readBudgetLimits,
} from "@/chat/services/budgets";

describe("system budgets", () => {
  it("uses one registry for config, descriptions, queue, and stop decisions", async () => {
    const limits = readBudgetLimits({}, () => undefined);
    expect(limits).toMatchObject({
      active_conversations_global: 100,
      turn_runtime: 21_600_000,
      turn_steps: 500,
    });
    expect(describeBudgets(limits)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Agent steps per turn",
          limit: 500,
          name: "turn_steps",
          outcome: "stop",
        }),
      ]),
    );
    await expect(
      checkBudgets(
        { active_conversations_global: 100 },
        { activeConversations: 100, stage: "conversation_admission" },
      ),
    ).resolves.toEqual({
      limit: 100,
      name: "active_conversations_global",
      outcome: "queue",
      value: 100,
    });
    const exceeded = await checkBudgets(
      { turn_steps: 500 },
      { runtimeMs: 0, stage: "turn", steps: 500 },
    );
    expect(exceeded).toEqual({
      limit: 500,
      name: "turn_steps",
      outcome: "stop",
      value: 500,
    });
    const error = new BudgetExceededError(exceeded!);
    expect(isBudgetExceededError(error)).toBe(true);
    expect(getBudgetAttributes(error.budget)).toEqual({
      "app.budget.limit": 500,
      "app.budget.name": "turn_steps",
      "app.budget.outcome": "stop",
      "app.budget.value": 500,
    });
  });

  it("gives users an actionable response without internal implementation details", () => {
    const response = buildBudgetExceededResponse("abc123");

    expect(response).toContain("reached a system budget");
    expect(response).toContain("smaller or more specific request");
    expect(response).toContain("event_id=abc123");
    expect(response).not.toContain("continuation");
  });
});
