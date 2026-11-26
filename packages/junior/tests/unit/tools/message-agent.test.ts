import { describe, expect, it, vi } from "vitest";
import { AgentStoppedError } from "@/chat/child-agents/errors";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { createMessageAgentTool } from "@/chat/tools/runtime/message-agent";

describe("messageAgent", () => {
  it("tells a stopped conversation to end its turn", async () => {
    const tool = createMessageAgentTool(
      vi.fn().mockRejectedValue(new AgentStoppedError()),
    );

    await expect(
      tool.execute!(
        { text: "Check it again.", to: "agent:child" },
        { toolCallId: "call-1" },
      ),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof ToolInputError &&
        error.message ===
          "This conversation is stopped, so it cannot give work to child agents. Do not start more work. End this turn.",
    );
  });
});
