import { describe, expect, it } from "vitest";
import {
  TurnExecutionLimitExceededError,
  TurnSliceLimitExceededError,
  TurnToolCallLimitExceededError,
  assertTurnToolCallBudget,
  buildTurnLimitResponse,
  countTurnToolCalls,
} from "@/chat/services/turn-limit";
import type { PiMessage } from "@/chat/pi/messages";

function assistantWithTools(...names: string[]): PiMessage {
  return {
    role: "assistant",
    content: names.map((name, index) => ({
      type: "toolCall",
      id: `call_${index}_${name}`,
      name,
      arguments: {},
    })),
    timestamp: indexTimestamp(names.length),
  } as PiMessage;
}

function indexTimestamp(value: number): number {
  return 1_700_000_000_000 + value;
}

describe("turn execution limit", () => {
  it("keeps the internal slice limit in diagnostics", () => {
    expect(new TurnSliceLimitExceededError(100)).toMatchObject({
      name: "TurnSliceLimitExceededError",
      message: "Agent turn exceeded execution limit (100 slices)",
    });
    expect(new TurnSliceLimitExceededError(100)).toBeInstanceOf(
      TurnExecutionLimitExceededError,
    );
  });

  it("keeps the internal tool-call limit in diagnostics", () => {
    expect(new TurnToolCallLimitExceededError(80)).toMatchObject({
      name: "TurnToolCallLimitExceededError",
      message: "Agent turn exceeded execution limit (80 tool calls)",
    });
    expect(new TurnToolCallLimitExceededError(80)).toBeInstanceOf(
      TurnExecutionLimitExceededError,
    );
  });

  it("gives users an actionable response without internal implementation details", () => {
    const response = buildTurnLimitResponse("abc123");

    expect(response).toContain("reached its execution limit");
    expect(response).toContain("smaller or more specific request");
    expect(response).toContain("event_id=abc123");
    expect(response).not.toContain("continuation");
  });

  it("counts tool calls already present on assistant messages", () => {
    expect(
      countTurnToolCalls([
        { role: "user", content: "go", timestamp: 1 } as PiMessage,
        assistantWithTools("bash", "bash"),
        assistantWithTools("loadSkill"),
      ]),
    ).toBe(3);
  });

  it("allows tool batches at the budget boundary and fails closed past it", () => {
    expect(() =>
      assertTurnToolCallBudget({
        existingToolCalls: 79,
        maxToolCalls: 80,
        pendingToolCalls: 1,
      }),
    ).not.toThrow();

    expect(() =>
      assertTurnToolCallBudget({
        existingToolCalls: 80,
        maxToolCalls: 80,
      }),
    ).not.toThrow();

    expect(() =>
      assertTurnToolCallBudget({
        existingToolCalls: 80,
        maxToolCalls: 80,
        pendingToolCalls: 1,
      }),
    ).toThrow(TurnToolCallLimitExceededError);

    expect(() =>
      assertTurnToolCallBudget({
        existingToolCalls: 81,
        maxToolCalls: 80,
        pendingToolCalls: 0,
      }),
    ).toThrow(/80 tool calls/);
  });
});
