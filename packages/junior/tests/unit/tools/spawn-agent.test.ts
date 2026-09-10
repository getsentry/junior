import { describe, expect, it, vi } from "vitest";
import {
  AgentInvocationBusyError,
  AgentInvocationLimitError,
} from "@/chat/agent-invocations/errors";
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

  it("maps named-agent busy errors to tool input errors", async () => {
    const tool = createSpawnAgentTool(
      vi.fn().mockRejectedValue(new AgentInvocationBusyError("researcher")),
    );

    await expect(
      tool.execute!(
        tool.prepareArguments!({
          task: "Investigate the failing checks.",
          name: "researcher",
        }),
        { toolCallId: "call-busy" },
      ),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof ToolInputError &&
        error.message.includes('Named agent "researcher" already has active work'),
    );
  });

  it("maps parent fan-out limit errors to tool input errors", async () => {
    const tool = createSpawnAgentTool(
      vi.fn().mockRejectedValue(new AgentInvocationLimitError(8)),
    );

    await expect(
      tool.execute!(
        tool.prepareArguments!({ task: "Investigate the failing checks." }),
        { toolCallId: "call-limit" },
      ),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof ToolInputError &&
        error.message.includes("active child agent invocations") &&
        error.message.includes("Wait for active children"),
    );
  });
});
