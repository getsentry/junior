import { describe, expect, it, vi } from "vitest";
import { createSpawnAgentTool } from "@/chat/tools/runtime/spawn-agent";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

describe("spawnAgent", () => {
  it("normalizes nullable optional fields before invoking the runtime control", async () => {
    const spawnAgent = vi.fn().mockResolvedValue({
      invocationId: "agent-invocation:one",
    });
    const tool = createSpawnAgentTool(spawnAgent);

    await expect(
      tool.execute!(
        tool.prepareArguments!({
          task: "Investigate the failing checks.",
          name: null,
          reasoning_level: null,
        }),
        { toolCallId: "call-1" },
      ),
    ).resolves.toEqual({
      invocation_id: "agent-invocation:one",
    });
    expect(spawnAgent).toHaveBeenCalledWith(
      { task: "Investigate the failing checks." },
      { toolCallId: "call-1" },
    );
  });

  it("requires the runtime tool call id used for durable replay", async () => {
    const tool = createSpawnAgentTool(vi.fn());

    await expect(
      tool.execute!(
        tool.prepareArguments!({ task: "Investigate the failing checks." }),
        {},
      ),
    ).rejects.toBeInstanceOf(ToolInputError);
  });
});
