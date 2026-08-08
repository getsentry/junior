import { describe, expect, it } from "vitest";
import { annotateTurnDeadlineToolResult } from "@/chat/tool-support/turn-deadline-result";

describe("annotateTurnDeadlineToolResult", () => {
  it("projects aborted tool results as unconfirmed outcomes without runtime jargon", () => {
    const result = annotateTurnDeadlineToolResult({
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

  it("ignores non-aborted tool outcomes", () => {
    expect(
      annotateTurnDeadlineToolResult({
        content: [{ type: "text", text: "ok" }],
        details: { target: "pnpm test", aborted: false, exit_code: 0 },
      }),
    ).toBeUndefined();
  });
});
