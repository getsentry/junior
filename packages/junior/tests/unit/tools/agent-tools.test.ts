import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginAuthorizationPauseError } from "@/chat/services/plugin-auth-orchestration";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { createAgentTools } from "@/chat/tools/agent-tools";
import type { Skill } from "@/chat/skills";

const { handleToolExecutionError } = vi.hoisted(() => ({
  handleToolExecutionError: vi.fn((error: unknown) => {
    throw error;
  }),
}));

vi.mock("@/chat/tools/execution/tool-error-handler", () => ({
  handleToolExecutionError,
}));

const githubSkill: Skill = {
  name: "github",
  description: "GitHub helper",
  skillPath: "/tmp/github",
  body: "instructions",
  pluginProvider: "github",
  allowedTools: ["bash"],
  usesConfig: ["github.repo"],
};

describe("createAgentTools", () => {
  beforeEach(() => {
    handleToolExecutionError.mockClear();
  });

  it("injects already-enabled provider credentials into bash", async () => {
    const sandbox = new SkillSandbox([githubSkill], [githubSkill]);
    const enableCredentialsForTurn = vi.fn(async () => {});
    const capabilityRuntime = {
      enableCredentialsForTurn,
      getTurnHeaderTransforms: () => [
        {
          domain: "api.github.com",
          headers: { Authorization: "Bearer token-1" },
        },
      ],
      getTurnEnv: () => ({
        GITHUB_TOKEN: "ghp_host_managed_credential",
      }),
    } as any;
    const sandboxExecutor = {
      canExecute: (toolName: string) => toolName === "bash",
      execute: vi.fn(async ({ input }) => ({
        result: {
          ok: true,
          command: (input as Record<string, unknown>).command,
          cwd: "/vercel/sandbox",
          exit_code: 0,
          signal: null,
          timed_out: false,
          stdout: "ok",
          stderr: "",
          stdout_truncated: false,
          stderr_truncated: false,
        },
      })),
    } as any;

    const [bashTool] = createAgentTools(
      {
        bash: {
          description: "bash",
          inputSchema: {} as any,
          execute: async () => ({ ok: true }),
        },
      },
      sandbox,
      {},
      undefined,
      sandboxExecutor,
      capabilityRuntime,
    );

    const result = await bashTool!.execute("tool-1", {
      command: "gh issue view 123 --repo getsentry/junior",
    });

    expect(enableCredentialsForTurn).not.toHaveBeenCalled();
    expect(sandboxExecutor.execute).toHaveBeenCalledWith({
      toolName: "bash",
      input: {
        command: "gh issue view 123 --repo getsentry/junior",
        env: {
          GITHUB_TOKEN: "ghp_host_managed_credential",
        },
        headerTransforms: [
          {
            domain: "api.github.com",
            headers: { Authorization: "Bearer token-1" },
          },
        ],
      },
    });
    expect(result.details).toMatchObject({
      ok: true,
      exit_code: 0,
    });
  });

  it("rethrows plugin auth pauses without reporting a tool failure", async () => {
    const sandbox = new SkillSandbox([githubSkill], [githubSkill]);
    const capabilityRuntime = {
      enableCredentialsForTurn: vi.fn(async () => undefined),
      getTurnHeaderTransforms: () => undefined,
      getTurnEnv: () => undefined,
    } as any;
    const pluginAuthOrchestration = {
      handleCommandFailure: vi.fn(async () => {
        throw new PluginAuthorizationPauseError("github");
      }),
    } as any;
    const sandboxExecutor = {
      canExecute: (toolName: string) => toolName === "bash",
      execute: vi.fn(async () => ({
        result: {
          ok: false,
          command: "gh issue view 123",
          cwd: "/vercel/sandbox",
          exit_code: 1,
          signal: null,
          timed_out: false,
          stdout: "",
          stderr: "bad credentials",
          stdout_truncated: false,
          stderr_truncated: false,
        },
      })),
    } as any;

    const [bashTool] = createAgentTools(
      {
        bash: {
          description: "bash",
          inputSchema: {} as any,
          execute: async () => ({ ok: true }),
        },
      },
      sandbox,
      {},
      undefined,
      sandboxExecutor,
      capabilityRuntime,
      pluginAuthOrchestration,
    );

    await expect(
      bashTool!.execute("tool-2", { command: "gh issue view 123" }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);
    expect(pluginAuthOrchestration.handleCommandFailure).toHaveBeenCalledWith({
      activeSkill: githubSkill,
      command: "gh issue view 123",
      details: expect.any(Object),
    });
    expect(handleToolExecutionError).not.toHaveBeenCalled();
  });
});
