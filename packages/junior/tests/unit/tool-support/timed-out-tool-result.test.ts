import { describe, expect, it } from "vitest";
import { projectTimedOutToolResult } from "@/chat/tool-support/timed-out-tool-result";

describe("projectTimedOutToolResult", () => {
  it("replaces aborted tool results with a timed_out outcome", () => {
    const result = projectTimedOutToolResult({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            target: "pnpm test",
            aborted: true,
            exit_code: 130,
            stderr: "Command aborted because the agent turn was cancelled.",
          }),
        },
      ],
      details: {
        target: "pnpm test",
        aborted: true,
        exit_code: 130,
        stderr: "Command aborted because the agent turn was cancelled.",
      },
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            outcome: "timed_out",
            target: "pnpm test",
          }),
        },
      ],
      details: {
        outcome: "timed_out",
        target: "pnpm test",
      },
      isError: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /cancelled|turn_deadline|execution_slice|unconfirmed|deadline/i,
    );
  });

  it("leaves non-aborted tool outcomes unchanged", () => {
    expect(
      projectTimedOutToolResult({
        content: [{ type: "text", text: "ok" }],
        details: { target: "pnpm test", aborted: false, exit_code: 0 },
      }),
    ).toBeUndefined();
  });
});
