import { describe, expect, it, vi } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
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
    source: createLocalSource("local:test:parent"),
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
      policy: { disabledFeatures: ["subagents"] },
    });

    expect(bindSpawnAgent).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      expect.not.objectContaining({
        durability: expect.objectContaining({ spawnAgent: expect.anything() }),
      }),
    );
  });

  it("preserves fixed child execution policy on delegated runs", async () => {
    const bindSpawnAgent = vi.fn();
    const run = vi.fn(async () => ({
      status: "suspended" as const,
      resumeVersion: 1,
    }));
    const runner = createAgentRunner(run, { bindSpawnAgent });

    await runner.run({
      ...request,
      policy: {
        disabledFeatures: ["handoff", "subagents"],
        reasoningLevel: "high",
      },
    });

    expect(bindSpawnAgent).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: expect.objectContaining({
          disabledFeatures: ["handoff", "subagents"],
          reasoningLevel: "high",
        }),
      }),
    );
  });
});
