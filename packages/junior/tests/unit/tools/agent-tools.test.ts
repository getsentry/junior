import { describe, expect, it, vi } from "vitest";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { createAgentTools } from "@/chat/tools/agent-tools";
import type { Skill } from "@/chat/skills";

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
  it("auto-enables provider credentials before executing bash", async () => {
    const sandbox = new SkillSandbox([githubSkill], [githubSkill]);
    const enableCredentialsForCommand = vi.fn(async () => {});
    const capabilityRuntime = {
      enableCredentialsForCommand,
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

    expect(enableCredentialsForCommand).toHaveBeenCalledWith({
      activeSkill: githubSkill,
      command: "gh issue view 123 --repo getsentry/junior",
      reason: "skill:github:bash:auto-enable",
    });
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
});
