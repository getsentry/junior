import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginAuthorizationPauseError } from "@/chat/services/plugin-auth-orchestration";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { createAgentTools } from "@/chat/tools/agent-tools";
import type { Skill } from "@/chat/skills";

const { handleToolExecutionError, setSpanAttributesMock, withSpanMock } =
  vi.hoisted(() => ({
    handleToolExecutionError: vi.fn((error: unknown) => {
      throw error;
    }),
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

describe("createAgentTools", () => {
  beforeEach(() => {
    handleToolExecutionError.mockClear();
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
      undefined,
      onToolCall,
    );

    await bashTool!.execute("tool-bash", { command: "which gh" });

    expect(onToolCall).toHaveBeenCalledWith("bash", { command: "which gh" });
  });

  it("records tool call arguments and result on the execute_tool span", async () => {
    const sandbox = new SkillSandbox([], []);
    const [bashTool] = createAgentTools(
      {
        bash: {
          description: "bash",
          inputSchema: {} as any,
          execute: async () => ({
            ok: true,
            stdout: "done",
          }),
        },
      },
      sandbox,
      {
        conversationId: "thread_123",
      },
    );

    const result = await bashTool!.execute("tool-bash", {
      command: "pwd",
    });

    expect(result.details).toEqual({
      ok: true,
      stdout: "done",
    });
    expect(withSpanMock).toHaveBeenCalledWith(
      "execute_tool bash",
      "gen_ai.execute_tool",
      {
        conversationId: "thread_123",
      },
      expect.any(Function),
      expect.objectContaining({
        "gen_ai.provider.name": "vercel-ai-gateway",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "bash",
        "gen_ai.tool.description": "bash",
        "gen_ai.tool.call.id": "tool-bash",
        "gen_ai.tool.call.arguments": expect.any(String),
      }),
    );
    expect(setSpanAttributesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        "gen_ai.tool.call.result": expect.any(String),
      }),
    );
  });

  it("records the raw tool result instead of the MCP envelope", async () => {
    const sandbox = new SkillSandbox([], []);
    const [mcpTool] = createAgentTools(
      {
        mcp__demo__ping: {
          description: "[demo] ping",
          inputSchema: {} as any,
          execute: async () => ({
            content: [{ type: "text", text: "pong" }],
            details: {
              provider: "demo",
              tool: "ping",
              rawResult: {
                content: [{ type: "text", text: "pong" }],
                isError: false,
              },
            },
          }),
        },
      },
      sandbox,
      {},
    );

    await mcpTool!.execute("tool-mcp", { query: "hello" });

    const resultCall = setSpanAttributesMock.mock.calls.find(
      (call) => call[0] && "gen_ai.tool.call.result" in call[0],
    );
    expect(resultCall).toBeDefined();
    const resultAttribute = resultCall?.[0]?.[
      "gen_ai.tool.call.result"
    ] as string;
    expect(resultAttribute).toContain('"isError":false');
    expect(resultAttribute).not.toContain('"provider":"demo"');
    expect(resultAttribute).not.toContain('"tool":"ping"');
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
        throw new PluginAuthorizationPauseError("github", "link_sent");
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
