import { describe, expect, it, vi } from "vitest";
import { CODE_MODE_MAX_OUTPUT_CHARS } from "@/chat/codemode/bridge";
import { createCodeModeTool } from "@/chat/codemode/tool";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { createToolPipeline } from "@/chat/tool-support/pi-tool-adapter";

function codeModeTool(writeFiles: () => Promise<undefined>) {
  let calls = 0;
  return createCodeModeTool({
    countToolCall: () => ++calls,
    pipeline: createToolPipeline({
      catalogTools: {},
      sandbox: new SkillSandbox([], []),
      spanContext: {},
    }),
    scriptTools: {},
    workspace: { writeFiles },
  });
}

function resultText(result: unknown): string {
  const { content } = result as { content: Array<{ text: string }> };
  return content[0]!.text;
}

describe("codemode output", () => {
  // The Sandbox is the faked edge: the tool saves long output there.
  it("saves the full text of long output to a Sandbox file", async () => {
    const writeFiles = vi.fn(async () => undefined);
    const tool = codeModeTool(writeFiles);
    const code = `text("x".repeat(${CODE_MODE_MAX_OUTPUT_CHARS})); return "end";`;

    const result = await tool.execute!(
      { code },
      { toolCallId: "call|codemode" },
    );

    const path = (result as { details: { outputPath?: string } }).details
      .outputPath;
    expect(path).toMatch(/\/\.junior\/codemode\/call_codemode\.txt$/);
    expect(writeFiles).toHaveBeenCalledWith([
      {
        content: `Output:\n${"x".repeat(CODE_MODE_MAX_OUTPUT_CHARS)}\nReturn value:\n"end"`,
        path,
      },
    ]);
    expect(resultText(result)).toContain(`The full text is in ${path}.`);

    // A failed write keeps the cut text and says the full text was not saved.
    writeFiles.mockRejectedValueOnce(new Error("sandbox unavailable"));
    const unsaved = await tool.execute!(
      { code },
      { toolCallId: "call-unsaved" },
    );
    expect(unsaved).toMatchObject({
      details: { ok: true, truncated: true },
    });
    expect(unsaved).not.toHaveProperty("details.outputPath");
    expect(resultText(unsaved)).toContain(
      "The output was cut. The full text was not saved.",
    );
  });
});
