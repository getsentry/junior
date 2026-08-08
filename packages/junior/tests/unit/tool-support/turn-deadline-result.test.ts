import { describe, expect, it } from "vitest";
import { annotateTurnDeadlineToolResult } from "@/chat/tool-support/turn-deadline-result";

describe("annotateTurnDeadlineToolResult", () => {
  it("rewrites cancelled abort text into a recoverable active-task boundary", () => {
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

    expect(result).toMatchObject({
      isError: true,
      details: {
        aborted: true,
        interruption: {
          cause: "turn_deadline",
          scope: "execution_slice",
          task_status: "active",
        },
        message: expect.stringMatching(/still active/i),
        stderr: expect.stringMatching(/still active/i),
      },
    });
    expect(result?.details).not.toEqual(
      expect.objectContaining({
        stderr: expect.stringMatching(/cancelled/i),
      }),
    );
    expect(JSON.stringify(result?.content)).not.toMatch(/cancelled/i);
    expect(JSON.stringify(result?.content)).toMatch(/still active/i);
    expect(JSON.stringify(result?.content)).toMatch(
      /without reporting the deadline/i,
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
