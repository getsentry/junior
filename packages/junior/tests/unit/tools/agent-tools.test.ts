import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginAuthorizationPauseError } from "@/chat/services/plugin-auth-orchestration";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { createAgentTools } from "@/chat/tools/agent-tools";
import { createBashTool } from "@/chat/tools/sandbox/bash";
import type { Skill } from "@/chat/skills";

const { setSpanAttributesMock, withSpanMock } = vi.hoisted(() => ({
  setSpanAttributesMock: vi.fn(),
  withSpanMock: vi.fn(
    async (
      _name: string,
      _op: string,
      _context: Record<string, unknown>,
      callback: () => Promise<unknown>,
      _attributes?: Record<string, unknown>,
    ) => callback(),
  ),
}));

vi.mock("@/chat/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/logging")>()),
  setSpanAttributes: setSpanAttributesMock,
  withSpan: withSpanMock,
}));

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

function createFailedBashSandboxExecutor() {
  return {
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
}

describe("createAgentTools", () => {
  beforeEach(() => {
    setSpanAttributesMock.mockClear();
    withSpanMock.mockClear();
  });

  it("emits assistant status only for reportProgress", async () => {
    const sandbox = new SkillSandbox([], []);
    const onStatus = vi.fn(async () => undefined);
    const [reportProgressTool, bashTool] = createAgentTools(
      {
        reportProgress: {
          description: "report progress",
          inputSchema: {} as any,
        },
        bash: {
          description: "bash",
          inputSchema: {} as any,
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
    );

    const result = await bashTool!.execute("tool-1", {
      command: "gh issue view 123 --repo getsentry/junior",
    });

    expect(sandboxExecutor.execute).toHaveBeenCalledWith({
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
    const sandboxExecutor = {
      canExecute: (toolName: string) => toolName === "bash",
      execute: vi.fn(async () => ({
        result: {
          ok: true,
          command: "sleep 60",
          cwd: "/vercel/sandbox",
          exit_code: 0,
          signal: null,
          timed_out: false,
          stdout: "",
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
    );

    await bashTool!.execute(
      "tool-1",
      {
        command: "sleep 60",
      },
      abortController.signal,
    );

    expect(sandboxExecutor.execute).toHaveBeenCalledWith({
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
          inputSchema: {} as any,
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
          inputSchema: {} as any,
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
    const prepareArguments = vi.fn((args: unknown) => args as never);
    const [editTool] = createAgentTools(
      {
        editFile: {
          description: "edit",
          inputSchema: {} as any,
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

  it("marks sandbox bash as sequential", () => {
    const sandbox = new SkillSandbox([], []);
    const [bashTool] = createAgentTools(
      {
        bash: createBashTool(),
      },
      sandbox,
      {},
    );

    expect(bashTool?.executionMode).toBe("sequential");
  });

  it.each(authorizationPassThroughCases)(
    "rethrows $name without reporting a tool failure",
    async ({ createError, expectedError }) => {
      const sandbox = new SkillSandbox([githubSkill], [githubSkill]);
      const pluginAuthOrchestration = {
        handleCommandFailure: vi.fn(async () => {
          throw createError();
        }),
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
        createFailedBashSandboxExecutor(),
        pluginAuthOrchestration,
        undefined,
      );

      await expect(
        bashTool!.execute("tool-2", { command: "gh issue view 123" }),
      ).rejects.toBeInstanceOf(expectedError);
      expect(pluginAuthOrchestration.handleCommandFailure).toHaveBeenCalledWith(
        {
          activeSkill: githubSkill,
          command: "gh issue view 123",
          details: expect.any(Object),
        },
      );
      expect(setSpanAttributesMock).not.toHaveBeenCalledWith(
        expect.objectContaining({
          "error.type": expect.any(String),
        }),
      );
    },
  );
});
