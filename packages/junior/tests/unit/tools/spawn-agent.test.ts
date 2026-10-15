import { describe, expect, it, vi } from "vitest";
import {
  AgentInvocationLimitError,
  AgentNameInUseError,
} from "@/chat/agent-invocations/errors";
import { createSpawnAgentTool } from "@/chat/tools/runtime/spawn-agent";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const profileControl = {
  activeProfile: () => "standard" as const,
  profiles: [
    { name: "standard" as const, description: "Routine work." },
    { name: "handoff" as const, description: "Implementation work." },
  ],
} as const;

describe("spawnAgent", () => {
  it("normalizes nullable optional fields before invoking the runtime control", async () => {
    const spawnAgent = vi.fn().mockResolvedValue({
      childConversationId: "agent:one",
    });
    const tool = createSpawnAgentTool(spawnAgent, profileControl);

    await expect(
      tool.execute!(
        tool.prepareArguments!({
          task: "Investigate the failing checks.",
          title: " Failing checks ",
          name: null,
          reasoning_level: null,
        }),
        { toolCallId: "call-1" },
      ),
    ).resolves.toEqual({
      conversation_id: "agent:one",
    });
    expect(spawnAgent).toHaveBeenCalledWith(
      {
        task: "Investigate the failing checks.",
        title: "Failing checks",
        profile: "standard",
      },
      { toolCallId: "call-1" },
    );
  });

  it("resolves an omitted profile from the active parent profile at call time", async () => {
    let activeProfile: "standard" | "handoff" = "standard";
    const spawnAgent = vi.fn().mockResolvedValue({
      childConversationId: "agent:one",
    });
    const tool = createSpawnAgentTool(spawnAgent, {
      ...profileControl,
      activeProfile: () => activeProfile,
    });
    activeProfile = "handoff";

    await tool.execute!(
      tool.prepareArguments!({
        task: "Continue the implementation.",
        title: "Continue implementation",
      }),
      { toolCallId: "call-current-profile" },
    );
    expect(spawnAgent).toHaveBeenCalledWith(
      {
        task: "Continue the implementation.",
        title: "Continue implementation",
        profile: "handoff",
      },
      { toolCallId: "call-current-profile" },
    );
  });

  it("accepts only configured profiles and passes an explicit choice", async () => {
    const spawnAgent = vi.fn().mockResolvedValue({
      childConversationId: "agent:one",
    });
    const tool = createSpawnAgentTool(spawnAgent, profileControl);
    const input = tool.prepareArguments!({
      task: "Implement the feature.",
      title: "Feature implementation",
      profile: "handoff",
    });

    await tool.execute!(input, { toolCallId: "call-profile" });
    expect(spawnAgent).toHaveBeenCalledWith(
      {
        task: "Implement the feature.",
        title: "Feature implementation",
        profile: "handoff",
      },
      { toolCallId: "call-profile" },
    );
    expect(() =>
      tool.prepareArguments!({ task: "Unknown profile.", profile: "missing" }),
    ).toThrow(ToolInputError);
  });

  it("requires the runtime tool call id used for durable replay", async () => {
    const tool = createSpawnAgentTool(vi.fn(), profileControl);

    await expect(
      tool.execute!(
        tool.prepareArguments!({ task: "Investigate the failing checks." }),
        {},
      ),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  it("points a used name to messageAgent", async () => {
    const tool = createSpawnAgentTool(
      vi.fn().mockRejectedValue(new AgentNameInUseError("researcher")),
      profileControl,
    );

    await expect(
      tool.execute!(
        tool.prepareArguments!({
          task: "Investigate the failing checks.",
          title: "Failing checks",
          name: "researcher",
        }),
        { toolCallId: "call-busy" },
      ),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof ToolInputError &&
        error.message.includes(
          'A child agent named "researcher" already exists',
        ) &&
        error.message.includes("Use messageAgent"),
    );
  });

  it("maps parent fan-out limit errors to tool input errors", async () => {
    const tool = createSpawnAgentTool(
      vi.fn().mockRejectedValue(new AgentInvocationLimitError(8)),
      profileControl,
    );

    await expect(
      tool.execute!(
        tool.prepareArguments!({
          task: "Investigate the failing checks.",
          title: "Failing checks",
        }),
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
