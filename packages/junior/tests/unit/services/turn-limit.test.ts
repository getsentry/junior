import { describe, expect, it } from "vitest";
import {
  TurnSliceLimitExceededError,
  TurnToolCallLimitExceededError,
  assertTurnToolCallLimit,
  buildTurnErrorResponse,
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
    const error = new TurnToolCallLimitExceededError(150);
    expect(error).toMatchObject({
      name: "TurnToolCallLimitExceededError",
      message: "Agent turn exceeded execution limit (150 tool calls)",
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

  it("allows tool calls at the limit and stops past it", () => {
    expect(() => assertTurnToolCallLimit(150, 150)).not.toThrow();
    expect(() => assertTurnToolCallLimit(151, 150)).toThrow(
      TurnToolCallLimitExceededError,
    );
    expect(() => assertTurnToolCallLimit(151, 150)).toThrow(/150 tool calls/);
  });

  it("uses the limit reply for thrown execution-limit errors", () => {
    const generic = (eventId: string) => `generic ${eventId}`;
    expect(
      buildTurnErrorResponse(
        new TurnToolCallLimitExceededError(150),
        "abc123",
        generic,
      ),
    ).toBe(buildTurnLimitResponse("abc123"));
    expect(
      buildTurnErrorResponse(
        new Error("boundary", {
          cause: new TurnToolCallLimitExceededError(150),
        }),
        "abc123",
        generic,
      ),
    ).toBe(buildTurnLimitResponse("abc123"));
    expect(buildTurnErrorResponse(new Error("boom"), "abc123", generic)).toBe(
      "generic abc123",
    );
  });
});
