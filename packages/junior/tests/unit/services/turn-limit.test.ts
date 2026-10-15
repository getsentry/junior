import { describe, expect, it } from "vitest";
import {
  TurnBudgetExceededError,
  TurnSliceLimitExceededError,
  TurnToolCallLimitExceededError,
  buildTurnErrorResponse,
  createTurnLimitGate,
  buildTurnLimitResponse,
  isTurnExecutionLimitExceededError,
} from "@/chat/services/turn-limit";

describe("turn execution limit", () => {
  it("keeps the internal slice limit in diagnostics", () => {
    const error = new TurnSliceLimitExceededError(100);
    expect(error).toMatchObject({
      name: "TurnSliceLimitExceededError",
      message: "Agent turn exceeded execution limit (100 slices)",
    });
    expect(isTurnExecutionLimitExceededError(error)).toBe(true);
  });

  it("keeps the internal tool-call limit in diagnostics", () => {
    const error = new TurnToolCallLimitExceededError(250);
    expect(error).toMatchObject({
      name: "TurnToolCallLimitExceededError",
      message: "Agent turn exceeded execution limit (250 tool calls)",
    });
    expect(isTurnExecutionLimitExceededError(error)).toBe(true);
  });

  it("keeps the internal budget limit in diagnostics", () => {
    const error = new TurnBudgetExceededError(100);
    expect(error).toMatchObject({
      name: "TurnBudgetExceededError",
      message: "Agent turn exceeded execution limit ($100 budget)",
    });
    expect(isTurnExecutionLimitExceededError(error)).toBe(true);
  });

  it("gives users an actionable response without internal implementation details", () => {
    const response = buildTurnLimitResponse("abc123");

    expect(response).toContain("reached its execution limit");
    expect(response).toContain("smaller or more specific request");
    expect(response).toContain("event_id=abc123");
    expect(response).not.toContain("continuation");
  });

  it("asks one model step to wrap up past a limit and stops the next one", () => {
    const gate = createTurnLimitGate();
    const first = {};
    const wrapUp = {};
    const ignored = {};

    expect(gate({ assistantMessage: first, overLimit: false })).toBe("allow");
    expect(gate({ assistantMessage: wrapUp, overLimit: true })).toBe("wrap_up");
    // Parallel tool calls in the same step get the same answer.
    expect(gate({ assistantMessage: wrapUp, overLimit: true })).toBe("wrap_up");
    expect(gate({ assistantMessage: ignored, overLimit: true })).toBe("stop");
  });

  it("uses the limit reply for thrown execution-limit errors", () => {
    expect(
      buildTurnErrorResponse(new TurnToolCallLimitExceededError(250), "abc123"),
    ).toBe(buildTurnLimitResponse("abc123"));
    expect(
      buildTurnErrorResponse(
        new Error("boundary", {
          cause: new TurnToolCallLimitExceededError(250),
        }),
        "abc123",
      ),
    ).toBe(buildTurnLimitResponse("abc123"));
    expect(buildTurnErrorResponse(new Error("boom"), "abc123")).toContain(
      "event_id=abc123",
    );
    expect(buildTurnErrorResponse(new Error("boom"), "abc123")).toContain(
      "internal error",
    );
  });
});
