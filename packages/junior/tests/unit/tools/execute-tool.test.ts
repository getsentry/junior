import { describe, expect, it } from "vitest";
import { createExecuteToolTool } from "@/chat/tools/execute-tool";

describe("executeTool", () => {
  it("cannot execute outside the agent dispatcher", async () => {
    const executeTool = createExecuteToolTool();

    await expect(
      executeTool.execute!(
        {
          tool_name: "agentDemo_lookupCustomer",
          arguments: {},
        },
        {},
      ),
    ).rejects.toThrow(
      "executeTool can only run through the agent tool dispatcher",
    );
  });

  it("tells the model to nest top-level catalog arguments", () => {
    const executeTool = createExecuteToolTool();

    expect(() =>
      executeTool.prepareArguments({ tool_name: "x", query: "q" }),
    ).toThrow(
      "executeTool arguments must be nested under arguments, not top-level fields: query",
    );
  });

  it("asks for a catalog tool_name when it is missing", () => {
    const executeTool = createExecuteToolTool();

    expect(() => executeTool.prepareArguments({})).toThrow(
      "executeTool requires a catalog tool_name",
    );
  });
});
