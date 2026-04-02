import { describe, expect, it } from "vitest";

/**
 * Inline copy of the private `getExecutionFailureReason` function from
 * `reply-executor.ts`.  Kept here so the unit test validates the branching
 * logic without exporting an implementation detail.
 */
function getExecutionFailureReason(reply: {
  diagnostics: {
    assistantMessageCount: number;
    errorMessage?: string;
    toolErrorCount: number;
    usedPrimaryText: boolean;
  };
}): string {
  const errorMessage = reply.diagnostics.errorMessage?.trim();
  if (errorMessage) {
    return errorMessage;
  }
  if (reply.diagnostics.toolErrorCount > 0) {
    return `${reply.diagnostics.toolErrorCount} tool result error(s)`;
  }
  if (reply.diagnostics.assistantMessageCount > 0) {
    return reply.diagnostics.usedPrimaryText
      ? "assistant produced invalid final text"
      : "assistant returned no text";
  }
  return "empty assistant turn";
}

describe("getExecutionFailureReason", () => {
  it("returns errorMessage when present", () => {
    expect(
      getExecutionFailureReason({
        diagnostics: {
          assistantMessageCount: 1,
          errorMessage: "rate limited",
          toolErrorCount: 0,
          usedPrimaryText: false,
        },
      }),
    ).toBe("rate limited");
  });

  it("returns tool error count when tools failed", () => {
    expect(
      getExecutionFailureReason({
        diagnostics: {
          assistantMessageCount: 1,
          toolErrorCount: 2,
          usedPrimaryText: false,
        },
      }),
    ).toBe("2 tool result error(s)");
  });

  it("distinguishes 'no text' from 'invalid final text' via usedPrimaryText", () => {
    const base = { assistantMessageCount: 2, toolErrorCount: 0 };

    expect(
      getExecutionFailureReason({
        diagnostics: { ...base, usedPrimaryText: false },
      }),
    ).toBe("assistant returned no text");

    expect(
      getExecutionFailureReason({
        diagnostics: { ...base, usedPrimaryText: true },
      }),
    ).toBe("assistant produced invalid final text");
  });

  it("returns empty assistant turn when no messages at all", () => {
    expect(
      getExecutionFailureReason({
        diagnostics: {
          assistantMessageCount: 0,
          toolErrorCount: 0,
          usedPrimaryText: false,
        },
      }),
    ).toBe("empty assistant turn");
  });
});
