import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunResult } from "@/chat/services/turn-result";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";

const executeAgentRunMock = vi.hoisted(() => vi.fn());

vi.mock("@/chat/agent-run", () => ({
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

describe("local chat CLI integration", () => {
  beforeEach(() => {
    vi.resetModules();
    executeAgentRunMock.mockReset();
  });

  afterEach(async () => {
    process.chdir(ORIGINAL_CWD);
    restoreEnv("JUNIOR_STATE_ADAPTER", ORIGINAL_STATE_ADAPTER);
    restoreEnv("REDIS_URL", ORIGINAL_REDIS_URL);
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
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
    executeAgentRunMock.mockResolvedValue(
      completedAgentRun(successReply("hello local")),
    );
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
          input: expect.objectContaining({ messageText: "hello" }),
          policy: expect.objectContaining({
            authorizationFlowMode: "disabled",
          }),
          routing: expect.objectContaining({
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
});
