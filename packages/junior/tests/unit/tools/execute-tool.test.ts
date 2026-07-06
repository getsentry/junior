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
});
