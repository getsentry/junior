import { describe, expect, it } from "vitest";
import { ContextSummaryError } from "@/chat/agent/context-summary";
import { ToolActionReviewUnavailableError } from "@/chat/guardian/gate";
import { createProviderError } from "@/chat/services/provider-error";
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
    const gate = createTurnLimitGate(false);
    const first = {};
    const wrapUp = {};

    expect(gate({ assistantMessage: first, overLimit: false })).toBe("allow");
    expect(gate({ assistantMessage: wrapUp, overLimit: true })).toBe("wrap_up");
    // Parallel tool calls in the same step get the same answer.
    expect(gate({ assistantMessage: wrapUp, overLimit: true })).toBe("wrap_up");
    // Live totals can miss usage, so a wrap-up stops later steps either way.
    expect(gate({ assistantMessage: {}, overLimit: false })).toBe("stop");
  });

  it("stops the first tool call after an earlier slice wrapped up", () => {
    const gate = createTurnLimitGate(true);

    expect(gate({ assistantMessage: {}, overLimit: false })).toBe("stop");
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

  // A thrown Turn error keeps the provider failure in its cause chain.
  it.each([
    {
      name: "action review",
      error: new ToolActionReviewUnavailableError({
        cause: createProviderError(
          "Service temporarily unavailable. Please try again shortly.",
          { modelId: "openai/gpt-6-luna" },
        ),
      }),
      reply:
        "OpenAI (gpt-6-luna, used for action review) is returning errors right now. This is an upstream provider problem, not something you did. Please try again shortly. Reference: `event_id=abc123`.",
    },
    {
      name: "context compaction",
      error: new Error("boundary", {
        cause: new ContextSummaryError("request_failed", undefined, {
          cause: createProviderError("Overloaded", {
            modelId: "anthropic/claude-opus-5.5",
          }),
        }),
      }),
      reply:
        "Anthropic (claude-opus-5.5) is at capacity right now. This is an upstream provider problem, not something you did. Please try again shortly. Reference: `event_id=abc123`.",
    },
  ])("names the upstream provider for a $name failure", ({ error, reply }) => {
    expect(buildTurnErrorResponse(error, "abc123")).toBe(reply);
  });
});
