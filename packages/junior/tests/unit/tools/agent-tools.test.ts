import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { PluginAuthorizationPauseError } from "@/chat/services/plugin-auth-orchestration";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { createAgentTools } from "@/chat/tools/agent-tools";
import { createBashTool } from "@/chat/tools/sandbox/bash";
import type { Skill } from "@/chat/skills";
import type {
  BashCustomCommandResult,
  SandboxExecutionEnvelope,
  SandboxExecutor,
} from "@/chat/sandbox/sandbox";
import type { PluginAuthOrchestration } from "@/chat/services/plugin-auth-orchestration";

const testInputSchema = Type.Object({}, { additionalProperties: true });

const githubSkill: Skill = {
  name: "github",
  description: "GitHub helper",
  skillPath: "/tmp/github",
  body: "instructions",
  pluginProvider: "github",
  allowedTools: ["bash"],
};

const authorizationPassThroughCases = [
  {
    name: "plugin auth pauses",
    createError: () => new PluginAuthorizationPauseError("github", "link_sent"),
    expectedError: PluginAuthorizationPauseError,
  },
  {
    name: "disabled authorization errors",
    createError: () => new AuthorizationFlowDisabledError("plugin", "github"),
    expectedError: AuthorizationFlowDisabledError,
  },
];

function bashResult(
  overrides: Partial<BashCustomCommandResult> = {},
): BashCustomCommandResult {
  return {
    ok: true,
    command: "bash command",
    cwd: "/vercel/sandbox",
    exit_code: 0,
    signal: null,
    timed_out: false,
    stdout: "ok",
    stderr: "",
    stdout_truncated: false,
    stderr_truncated: false,
    ...overrides,
  };
}

function createTestSandboxExecutor(args: {
  canExecute?: (toolName: string) => boolean;
  execute?: (params: {
    input: unknown;
    signal?: AbortSignal;
    toolName: string;
  }) => Promise<SandboxExecutionEnvelope>;
}): SandboxExecutor {
  const execute =
    args.execute ??
    vi.fn(async () => ({
      result: bashResult(),
    }));

  return {
    canExecute: args.canExecute ?? ((toolName) => toolName === "bash"),
    configureReferenceFiles: () => {},
    configureSkills: () => {},
    createSandbox: async () => {
      throw new Error("Unexpected sandbox creation in agent tool unit test");
    },
    dispose: async () => undefined,
    async execute<T>(params: {
      input: unknown;
      signal?: AbortSignal;
      toolName: string;
    }) {
      const envelope = await execute(params);
      return { result: envelope.result as T };
    },
    getDependencyProfileHash: () => undefined,
    getSandboxId: () => undefined,
  };
}

function createFailedBashSandboxExecutor(): SandboxExecutor {
  return createTestSandboxExecutor({
    execute: vi.fn(async () => ({
      result: bashResult({
        ok: false,
        command: "gh issue view 123",
        exit_code: 1,
        stdout: "",
        stderr: "bad credentials",
      }),
    })),
  });
}

describe("createAgentTools", () => {
  it("emits assistant status only for reportProgress", async () => {
    const sandbox = new SkillSandbox([], []);
    const onStatus = vi.fn(async () => undefined);
    const [reportProgressTool, bashTool] = createAgentTools(
      {
        reportProgress: {
          description: "report progress",
          inputSchema: testInputSchema,
        },
        bash: {
          description: "bash",
          inputSchema: testInputSchema,
          execute: async () => ({ ok: true }),
        },
      },
      sandbox,
      {},
      onStatus,
    );

    await reportProgressTool!.execute("tool-progress", {
      message: "  Reviewing results  ",
    });
    await bashTool!.execute("tool-bash", { command: "pwd" });

    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith({ text: "Reviewing results" });
  });

  it("executes sandbox bash without host credential injection", async () => {
    const sandbox = new SkillSandbox([githubSkill], [githubSkill]);
    const execute = vi.fn(async ({ input }: { input: unknown }) => ({
      result: bashResult({
        command:
          input && typeof input === "object" && "command" in input
            ? String(input.command)
            : "",
      }),
    }));
    const sandboxExecutor = createTestSandboxExecutor({ execute });

    const [bashTool] = createAgentTools(
      {
        bash: {
          description: "bash",
          inputSchema: testInputSchema,
          execute: async () => ({ ok: true }),
        },
      },
      sandbox,
      {},
      undefined,
      sandboxExecutor,
    );

    const result = await bashTool!.execute("tool-1", {
      command: "gh issue view 123 --repo getsentry/junior",
    });

    expect(execute).toHaveBeenCalledWith({
      toolName: "bash",
      input: {
        command: "gh issue view 123 --repo getsentry/junior",
      },
    });
    expect(result.details).toMatchObject({
      ok: true,
      exit_code: 0,
    });
  });

  it("passes Pi abort signals to sandbox execution", async () => {
    const sandbox = new SkillSandbox([], []);
    const abortController = new AbortController();
    const execute = vi.fn(async () => ({
      result: bashResult({
        command: "sleep 60",
        stdout: "",
      }),
    }));
    const sandboxExecutor = createTestSandboxExecutor({ execute });

    const [bashTool] = createAgentTools(
      {
        bash: {
          description: "bash",
          inputSchema: testInputSchema,
          execute: async () => ({ ok: true }),
        },
      },
      sandbox,
      {},
      undefined,
      sandboxExecutor,
    );

    await bashTool!.execute(
      "tool-1",
      {
        command: "sleep 60",
      },
      abortController.signal,
    );

    expect(execute).toHaveBeenCalledWith({
      toolName: "bash",
      input: {
        command: "sleep 60",
      },
      signal: abortController.signal,
    });
  });

  it("passes Pi abort signals to non-sandbox tools", async () => {
    const sandbox = new SkillSandbox([], []);
    const abortController = new AbortController();
    const execute = vi.fn(async () => ({
      ok: true,
    }));

    const [demoTool] = createAgentTools(
      {
        demo: {
          description: "demo",
          inputSchema: testInputSchema,
          execute,
        },
      },
      sandbox,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "public",
    );

    await demoTool!.execute(
      "tool-demo",
      {
        value: "input",
      },
      abortController.signal,
    );

    expect(execute).toHaveBeenCalledWith(
      {
        value: "input",
      },
      {
        experimental_context: sandbox,
        signal: abortController.signal,
        conversationPrivacy: "public",
        toolCallId: "tool-demo",
      },
    );
  });

  it("reports tool call parameters to the caller", async () => {
    const sandbox = new SkillSandbox([], []);
    const onToolCall = vi.fn();
    const [bashTool] = createAgentTools(
      {
        bash: {
          description: "bash",
          inputSchema: testInputSchema,
          execute: async () => ({ ok: true }),
        },
      },
      sandbox,
      {},
      undefined,
      undefined,
      undefined,
      onToolCall,
    );

    await bashTool!.execute("tool-bash", { command: "which gh" });

    expect(onToolCall).toHaveBeenCalledWith("bash", { command: "which gh" });
  });

  it("forwards Pi tool preparation metadata", () => {
    const sandbox = new SkillSandbox([], []);
    const prepareArguments = vi.fn(() => ({}));
    const [editTool] = createAgentTools(
      {
        editFile: {
          description: "edit",
          inputSchema: testInputSchema,
          prepareArguments,
          executionMode: "sequential",
          execute: async () => ({ ok: true }),
        },
      },
      sandbox,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "public",
    );

    expect(editTool?.prepareArguments).toBe(prepareArguments);
    expect(editTool?.executionMode).toBe("sequential");
  });

  it.each(authorizationPassThroughCases)(
    "rethrows $name without reporting a tool failure",
    async ({ createError, expectedError }) => {
      const sandbox = new SkillSandbox([githubSkill], [githubSkill]);
      const pluginAuthOrchestration = {
        maybeHandleAuthSignal: vi.fn(async () => {
          throw createError();
        }),
        getPendingPause: () => undefined,
      } satisfies PluginAuthOrchestration;

      const [bashTool] = createAgentTools(
        {
          bash: {
            description: "bash",
            inputSchema: testInputSchema,
            execute: async () => ({ ok: true }),
          },
        },
        sandbox,
        {},
        undefined,
        createFailedBashSandboxExecutor(),
        pluginAuthOrchestration,
        undefined,
      );

      await expect(
        bashTool!.execute("tool-2", { command: "gh issue view 123" }),
      ).rejects.toBeInstanceOf(expectedError);
      expect(pluginAuthOrchestration.maybeHandleAuthSignal).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "gh issue view 123",
          exit_code: 1,
          stderr: "bad credentials",
        }),
      );
    },
  );
});
