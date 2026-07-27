import { describe, expect, it, vi } from "vitest";
import { createSpawnAgentTool } from "@/chat/tools/runtime/spawn-agent";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

describe("spawnAgent", () => {
  it("normalizes nullable optional fields before invoking the runtime control", async () => {
    const execute = vi.fn().mockResolvedValue({
      childConversationId: "agent:child",
      invocationId: "agent-invocation:one",
      replayed: false,
      status: "pending",
    });
    const tool = createSpawnAgentTool({ execute });

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
      ok: true,
      status: "success",
      child_conversation_id: "agent:child",
      invocation_id: "agent-invocation:one",
      invocation_status: "pending",
      replayed: false,
    });
    expect(execute).toHaveBeenCalledWith(
      { task: "Investigate the failing checks." },
      { toolCallId: "call-1" },
    );
  });

  it("requires the runtime tool call id used for durable replay", async () => {
    const tool = createSpawnAgentTool({
      execute: vi.fn(),
    });

    await expect(
      tool.execute!(
        tool.prepareArguments!({ task: "Investigate the failing checks." }),
        {},
      ),
    ).rejects.toBeInstanceOf(ToolInputError);
  });
});
