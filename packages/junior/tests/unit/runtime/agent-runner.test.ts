import { describe, expect, it, vi } from "vitest";
import type { AgentRunRequest } from "@/chat/agent/request";
import { createAgentRunner } from "@/chat/runtime/agent-runner";

const request = {
  conversationId: "local:test:parent",
  turnId: "turn-1",
  input: { messageText: "Delegate this task." },
  routing: {
    destination: {
      conversationId: "local:test:parent",
      platform: "local",
    },
    source: {
      conversationId: "local:test:parent",
      platform: "local",
      type: "priv",
    },
  },
} satisfies AgentRunRequest;

describe("agent runner controls", () => {
  it("binds spawnAgent into the active run durability context", async () => {
    const spawnAgent = vi.fn();
    const bindSpawnAgent = vi.fn(() => spawnAgent);
    const run = vi.fn(async () => ({
      status: "suspended" as const,
      resumeVersion: 1,
    }));
    const runner = createAgentRunner(run, { bindSpawnAgent });

    await runner.run(request);

    expect(bindSpawnAgent).toHaveBeenCalledWith(request);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        durability: { spawnAgent },
      }),
    );
  });

  it("does not advertise recursive spawning to delegated runs", async () => {
    const bindSpawnAgent = vi.fn();
    const run = vi.fn(async () => ({
      status: "suspended" as const,
      resumeVersion: 1,
    }));
    const runner = createAgentRunner(run, { bindSpawnAgent });

    await runner.run({
      ...request,
      policy: { agentSpawning: "disabled" },
    });

    expect(bindSpawnAgent).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      expect.not.objectContaining({
        durability: expect.objectContaining({ spawnAgent: expect.anything() }),
      }),
    );
  });
});
