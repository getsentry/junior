import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunRequest } from "@/chat/agent/request";
import type { AgentRunResult } from "@/chat/services/turn-result";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { deliverAssistantMessagesForTest } from "../../fixtures/agent-runner";

const executeAgentRunMock = vi.hoisted(() => vi.fn());

vi.mock("@/chat/agent", () => ({
  executeAgentRun: executeAgentRunMock,
}));

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_STATE_ADAPTER = process.env.JUNIOR_STATE_ADAPTER;
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function successReply(text: string): AgentRunResult {
  return {
    text,
    diagnostics: {
      assistantMessageCount: 1,
      modelId: "fake-local-chat-cli",
      outcome: "success",
      toolCalls: [],
      toolErrorCount: 0,
      toolResultCount: 0,
      usedPrimaryText: true,
    },
  };
}

describe("local chat CLI composition", () => {
  beforeEach(() => {
    vi.resetModules();
    executeAgentRunMock.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("dev server unavailable");
      }),
    );
  });

  afterEach(async () => {
    process.chdir(ORIGINAL_CWD);
    restoreEnv("JUNIOR_STATE_ADAPTER", ORIGINAL_STATE_ADAPTER);
    restoreEnv("REDIS_URL", ORIGINAL_REDIS_URL);
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("loads app plugins and applies the local memory default before runtime config", async () => {
    delete process.env.JUNIOR_STATE_ADAPTER;
    process.env.REDIS_URL = "redis://localhost:6379";
    const tempDir = mkdtempSync(path.join(tmpdir(), "junior-local-chat-"));
    writeFileSync(
      path.join(tempDir, "plugins.ts"),
      `const packageNames: string[] = [];

export const plugins = {
  packageNames,
  registrations: [
    {
      manifest: {
        name: "local-chat-plugin",
        displayName: "Local Chat Plugin",
        description: "Local chat integration plugin",
      },
    },
  ],
};
`,
    );
    process.chdir(tempDir);
    executeAgentRunMock.mockImplementation(async (request) => {
      await deliverAssistantMessagesForTest(request, [{ text: "hello local" }]);
      return completedAgentRun(successReply("hello local"));
    });
    const output: string[] = [];

    try {
      const { runChat } = await import("@/cli/chat");
      await expect(
        runChat(["-p", "hello"], {
          error: vi.fn(),
          input: process.stdin,
          output: process.stdout,
          write: (text) => {
            output.push(text);
          },
        }),
      ).resolves.toBe(0);

      const { getChatConfig } = await import("@/chat/config");
      expect(getChatConfig().state.adapter).toBe("memory");
      const { pluginCatalogRuntime } =
        await import("@/chat/plugins/catalog-runtime");
      expect(
        pluginCatalogRuntime
          .getProviders()
          .map((plugin) => plugin.manifest.name),
      ).toContain("local-chat-plugin");
      expect(executeAgentRunMock).toHaveBeenCalledWith(
        expect.objectContaining({
          authorization: expect.objectContaining({
            createState: expect.any(Function),
            deliver: expect.any(Function),
          }),
          input: expect.objectContaining({ messageText: "hello" }),
          policy: expect.objectContaining({
            authorizationFlowMode: "interactive",
            sandboxEgressSignals: expect.objectContaining({
              clear: expect.any(Function),
              consume: expect.any(Function),
            }),
          }),
          routing: expect.objectContaining({
            credentialContext: {
              actor: { type: "user", userId: "local-cli" },
            },
            destination: expect.objectContaining({ platform: "local" }),
          }),
        }),
      );
      expect(output).toEqual(["hello local\n"]);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { force: true, recursive: true });
    }
  }, 30_000);

  it("finishes spawned child work in process before prompt mode exits", async () => {
    delete process.env.JUNIOR_STATE_ADAPTER;
    const requests: AgentRunRequest[] = [];
    executeAgentRunMock.mockImplementation(async (request) => {
      requests.push(request);
      if (request.policy?.agentSpawning === "disabled") {
        await request.durability.onInputCommitted?.();
        return completedAgentRun(successReply("child finished"));
      }
      const spawnAgent = request.durability.spawnAgent;
      if (!spawnAgent) {
        throw new Error("parent run requires spawnAgent");
      }
      const spawned = await spawnAgent.execute(
        {
          name: "local-test-child",
          reasoningLevel: "medium",
          task: "Finish the child task.",
        },
        { toolCallId: "spawn-1" },
      );
      expect(spawned).toMatchObject({ status: "pending" });
      await deliverAssistantMessagesForTest(request, [
        { text: "child scheduled" },
      ]);
      return completedAgentRun(successReply("child scheduled"));
    });
    const output: string[] = [];

    const { runChat } = await import("@/cli/chat");
    await expect(
      runChat(
        ["-p", "delegate this"],
        {
          error: vi.fn(),
          input: process.stdin,
          output: process.stdout,
          write: (text) => {
            output.push(text);
          },
        },
        { pluginSet: null },
      ),
    ).resolves.toBe(0);

    expect(executeAgentRunMock).toHaveBeenCalledTimes(2);
    expect(requests[0]?.durability?.spawnAgent).toBeDefined();
    expect(requests[1]).toMatchObject({
      policy: { agentSpawning: "disabled" },
    });
    expect(requests[1]?.durability?.spawnAgent).toBeUndefined();
    expect(output).toEqual(["child scheduled\n"]);
  }, 30_000);
});
