import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginAuthorizationPauseError } from "@/chat/services/plugin-auth-orchestration";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { createPiAgentTools } from "@/chat/tool-support/pi-tool-adapter";
import { createReportProgressTool } from "@/chat/tools/runtime/report-progress";
import { createBashTool } from "@/chat/tools/sandbox/bash";
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
};

describe("Pi tool adapter", () => {
  beforeEach(() => {
    handleToolExecutionError.mockClear();
  });

  it("emits assistant status only for reportProgress", async () => {
    const sandbox = new SkillSandbox([], []);
    const onStatus = vi.fn(async () => undefined);
    const [reportProgressTool, bashTool] = createPiAgentTools(
      {
        reportProgress: createReportProgressTool(),
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

  it("emits assistant status when reportProgress runs through executeTool", async () => {
    const sandbox = new SkillSandbox([], []);
    const onStatus = vi.fn(async () => undefined);
    const tools = createPiAgentTools(
      {
        reportProgress: createReportProgressTool(),
      },
      sandbox,
      {},
      onStatus,
    );
    const executeTool = tools.find(
      (candidate) => candidate.name === "executeTool",
    );
    if (!executeTool) {
      throw new Error("executeTool was not registered");
    }

    await executeTool.execute("tool-progress", {
      tool_name: "reportProgress",
      arguments: {
        message: "  Reviewing catalog execution  ",
      },
    });

    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith({
      text: "Reviewing catalog execution",
    });
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

    const [bashTool] = createPiAgentTools(
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

    const [bashTool] = createPiAgentTools(
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

    const [demoTool] = createPiAgentTools(
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
      expect.objectContaining({
        experimental_context: sandbox,
        signal: abortController.signal,
        conversationPrivacy: "public",
        toolCallId: "tool-demo",
      }),
    );
  });

  it("reports tool call parameters to the caller", async () => {
    const sandbox = new SkillSandbox([], []);
    const onToolCall = vi.fn();
    const [bashTool] = createPiAgentTools(
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

  it("reports structured tool error results to observers", async () => {
    const sandbox = new SkillSandbox([], []);
    const onToolResult = vi.fn();
    const [demoTool] = createPiAgentTools(
      {
        demo: {
          description: "demo",
          inputSchema: {} as any,
          execute: async () => ({
            ok: false,
            status: "error",
            error: {
              kind: "not_found",
              message: "Thing not found.",
            },
          }),
        },
      },
      sandbox,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "private",
      onToolResult,
    );

    await demoTool!.execute("tool-demo", { id: "missing" });

    expect(onToolResult).toHaveBeenCalledWith({
      ok: false,
      params: { id: "missing" },
      result: expect.objectContaining({
        ok: false,
        status: "error",
      }),
      toolName: "demo",
    });
  });

  it("forwards Pi tool preparation metadata", () => {
    const sandbox = new SkillSandbox([], []);
    const prepareArguments = vi.fn((args: unknown) => args as never);
    const [editTool] = createPiAgentTools(
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
    const [bashTool] = createPiAgentTools(
      {
        bash: createBashTool(),
      },
      sandbox,
      {},
    );

    expect(bashTool?.executionMode).toBe("sequential");
  });

  it("rethrows plugin auth pauses without reporting a tool failure", async () => {
    const sandbox = new SkillSandbox([githubSkill], [githubSkill]);
    const pluginAuthOrchestration = {
      maybeHandleAuthSignal: vi.fn(async () => {
        throw new PluginAuthorizationPauseError(
          "github",
          "GitHub",
          "link_sent",
        );
      }),
    } as any;
    const authRequired = {
      provider: "github",
      grant: {
        name: "default",
        access: "read",
        reason: "sandbox-egress:github:read",
      },
      authorization: {
        type: "oauth",
        provider: "github",
        scope: "repo",
      },
      createdAtMs: Date.now(),
    };
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
          auth_required: authRequired,
        },
      })),
    } as any;

    const [bashTool] = createPiAgentTools(
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
      pluginAuthOrchestration,
      undefined,
    );

    await expect(
      bashTool!.execute("tool-2", { command: "gh issue view 123" }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);
    expect(pluginAuthOrchestration.maybeHandleAuthSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "gh issue view 123",
        auth_required: authRequired,
      }),
    );
    expect(handleToolExecutionError).not.toHaveBeenCalled();
  });

  it("rethrows disabled authorization errors without reporting a tool failure", async () => {
    const sandbox = new SkillSandbox([githubSkill], [githubSkill]);
    const pluginAuthOrchestration = {
      maybeHandleAuthSignal: vi.fn(async () => {
        throw new AuthorizationFlowDisabledError("plugin", "github");
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

    const [bashTool] = createPiAgentTools(
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
      pluginAuthOrchestration,
      undefined,
    );

    await expect(
      bashTool!.execute("tool-2", { command: "gh issue view 123" }),
    ).rejects.toBeInstanceOf(AuthorizationFlowDisabledError);
    expect(handleToolExecutionError).not.toHaveBeenCalled();
  });
});
