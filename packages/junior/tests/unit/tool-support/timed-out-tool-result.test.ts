import { describe, expect, it } from "vitest";
import { projectTimedOutToolResult } from "@/chat/tool-support/timed-out-tool-result";

describe("projectTimedOutToolResult", () => {
  it("projects host-preempted tools onto the native timed_out field", () => {
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
            target: "pnpm test",
            timed_out: true,
          }),
        },
      ],
      details: {
        target: "pnpm test",
        timed_out: true,
      },
      isError: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /cancelled|turn_deadline|execution_slice|unconfirmed|outcome|deadline/i,
    );
  });

  it("still projects when details only carry a target", () => {
    expect(
      projectTimedOutToolResult({
        content: [{ type: "text", text: "partial" }],
        details: { target: "editFile" },
      }),
    ).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            target: "editFile",
            timed_out: true,
          }),
        },
      ],
      details: {
        target: "editFile",
        timed_out: true,
      },
      isError: false,
    });
  });
});
