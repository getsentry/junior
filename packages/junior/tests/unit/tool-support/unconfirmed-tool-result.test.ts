import { describe, expect, it } from "vitest";
import { projectUnconfirmedToolResult } from "@/chat/tool-support/unconfirmed-tool-result";

describe("projectUnconfirmedToolResult", () => {
  it("replaces aborted tool results with an unconfirmed outcome", () => {
    const result = projectUnconfirmedToolResult({
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
            outcome: "unconfirmed",
            target: "pnpm test",
          }),
        },
      ],
      details: {
        outcome: "unconfirmed",
        target: "pnpm test",
      },
      isError: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /cancelled|turn_deadline|execution_slice|deadline/i,
    );
  });

  it("leaves non-aborted tool outcomes unchanged", () => {
    expect(
      projectUnconfirmedToolResult({
        content: [{ type: "text", text: "ok" }],
        details: { target: "pnpm test", aborted: false, exit_code: 0 },
      }),
    ).toBeUndefined();
  });
});
