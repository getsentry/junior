import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginAuthorizationPauseError } from "@/chat/services/plugin-auth-orchestration";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { createPiAgentTools } from "@/chat/tool-support/pi-tool-adapter";
import {
  createToolActionReview,
  type ToolActionReview,
  type ToolActionReviewer,
} from "@/chat/tool-support/action-review";
import { createReportProgressTool } from "@/chat/tools/runtime/report-progress";
import { createCallMcpToolTool } from "@/chat/tools/skill/call-mcp-tool";
import { createBashTool } from "@/chat/tools/sandbox/bash";
import type { Skill } from "@/chat/skills";
import type { PluginHookRunner } from "@/chat/plugins/agent-hooks";

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

function actionReview(
  reviewer: ToolActionReviewer,
  userIntent: string,
  onFatal = vi.fn(),
): ToolActionReview {
  return createToolActionReview({
    context: {
      actor: { platform: "local", userId: "local-user" },
      conversationId: "local:tool-review",
      destination: {
        platform: "local",
        conversationId: "local:tool-review",
      },
      source: {
        platform: "local",
        visibility: "private",
        conversationId: "local:tool-review",
      },
      userIntent: () => userIntent,
    },
    onDecision: vi.fn(async () => undefined),
    onFatal,
    reviewer,
  });
}

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
      supports: (toolName: string) => toolName === "bash",
      execute: vi.fn(async ({ input }) => ({
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
      supports: (toolName: string) => toolName === "bash",
      execute: vi.fn(async () => ({
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

    expect(onToolCall).toHaveBeenCalledWith("tool-bash", "bash", {
      command: "which gh",
    });
  });

  it("reviews validated actions immediately before execution", async () => {
    const sandbox = new SkillSandbox([], []);
    const execute = vi.fn(async () => ({ ok: true }));
    const review = vi.fn<ToolActionReviewer["review"]>(async () => ({
      decision: "allow" as const,
      reason: "The action matches the request.",
      riskLevel: "low" as const,
      userAuthorization: "high" as const,
    }));
    const [demoTool] = createPiAgentTools(
      {
        demo: {
          approvalMode: "review",
          description: "Create the report.",
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
      "private",
      undefined,
      actionReview({ review }, "Create the report."),
    );

    await demoTool!.execute("tool-demo", { reportId: "weekly" });

    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { reportId: "weekly" },
        tool: expect.objectContaining({ name: "demo" }),
      }),
      {},
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(review.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[0]!,
    );
  });

  it("reviews an active MCP tool before execution", async () => {
    const sandbox = new SkillSandbox([], []);
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "deleted" }],
    }));
    const managedTool = {
      name: "mcp__demo__delete-workspace",
      rawName: "delete-workspace",
      provider: "demo",
      description: "Permanently delete a workspace.",
      parameters: {},
      annotations: {
        destructiveHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      execute,
    };
    const activeTools = [managedTool];
    const review = vi.fn<ToolActionReviewer["review"]>(async () => ({
      decision: "allow" as const,
      reason: "The user explicitly requested this deletion.",
      riskLevel: "high" as const,
      userAuthorization: "high" as const,
    }));
    const callMcpTool = createCallMcpToolTool({
      getResolvedActiveTools: () => activeTools,
    });
    const tools = createPiAgentTools(
      { callMcpTool },
      sandbox,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "private",
      undefined,
      actionReview({ review }, "Delete preview-42."),
    );
    const piCallMcpTool = tools.find(
      (candidate) => candidate.name === "callMcpTool",
    );
    if (!piCallMcpTool) {
      throw new Error("callMcpTool was not registered");
    }

    await piCallMcpTool.execute("tool-mcp", {
      tool_name: managedTool.name,
      arguments: { workspace: "preview-42" },
    });

    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          tool_name: managedTool.name,
          arguments: { workspace: "preview-42" },
        },
        tool: expect.objectContaining({
          annotations: managedTool.annotations,
          dispatcherName: "callMcpTool",
          name: managedTool.name,
        }),
      }),
      {},
    );
    expect(review.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[0]!,
    );
    expect(execute).toHaveBeenCalledWith(
      { workspace: "preview-42" },
      {
        conversationPrivacy: "private",
        toolCallId: "tool-mcp",
      },
    );
  });

  it("reviews semantic env without exposing hook-injected env", async () => {
    const sandbox = new SkillSandbox([], []);
    const execute = vi.fn(async () => ({ ok: true }));
    const review = vi.fn<ToolActionReviewer["review"]>(async () => ({
      decision: "allow" as const,
      reason: "The action matches the request.",
      riskLevel: "low" as const,
      userAuthorization: "high" as const,
    }));
    const pluginHooks = {
      afterMcpTool: vi.fn(async () => undefined),
      beforeToolExecute: vi.fn(async () => ({
        input: {
          reportId: "monthly",
          env: { OUTPUT_FORMAT: "summary" },
        },
        env: { SECRET_TOKEN: "must-not-reach-guardian" },
      })),
      prepareSandbox: vi.fn(),
      prepareWorkspace: vi.fn(),
    } as PluginHookRunner;
    const [demoTool] = createPiAgentTools(
      {
        demo: {
          approvalMode: "review",
          description: "Create the report.",
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
      pluginHooks,
      "private",
      undefined,
      actionReview({ review }, "Create the monthly report."),
    );

    await demoTool!.execute("tool-demo", { reportId: "weekly" });

    expect(review.mock.calls[0]?.[0].input).toEqual({
      env: { OUTPUT_FORMAT: "summary" },
      reportId: "monthly",
    });
    expect(JSON.stringify(review.mock.calls[0]?.[0])).not.toContain(
      "must-not-reach-guardian",
    );
    expect(execute).toHaveBeenCalledWith(
      {
        env: {
          OUTPUT_FORMAT: "summary",
          SECRET_TOKEN: "must-not-reach-guardian",
        },
        reportId: "monthly",
      },
      expect.any(Object),
    );
  });

  it("reviews each attempt and interrupts after three consecutive rejections", async () => {
    const sandbox = new SkillSandbox([], []);
    const execute = vi.fn(async () => ({ ok: true }));
    const onToolResult = vi.fn();
    const onFatal = vi.fn();
    const review = vi.fn<ToolActionReviewer["review"]>(async () => ({
      decision: "ask",
      reason: "Recurring work should be confirmed.",
      riskLevel: "medium",
      userAuthorization: "low",
    }));
    const reviewState = actionReview(
      { review },
      "Create the recurring report.",
      onFatal,
    );
    const [demoTool] = createPiAgentTools(
      {
        demo: {
          approvalMode: "review",
          description: "Create the recurring report.",
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
      "private",
      onToolResult,
      reviewState,
    );

    await expect(
      demoTool!.execute("tool-demo", { cadence: "weekly" }),
    ).rejects.toThrow(
      "Stop tool use for this turn and respond to the user now with a direct, concise confirmation question that names the exact action, target, and material side effects.",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(
      reviewState.projectToolResult("tool-demo", { isError: true }),
    ).toMatchObject({
      details: {
        guardianActionRejection: {
          decision: "ask",
          reason: "Recurring work should be confirmed.",
          version: 1,
        },
      },
      isError: true,
    });
    expect(onToolResult).toHaveBeenCalledWith({
      error: [
        "The action was not executed because explicit user confirmation is required.",
        "Stop tool use for this turn and respond to the user now with a direct, concise confirmation question that names the exact action, target, and material side effects.",
        "Do not mention Guardian, the runtime, policy, or internal review mechanics.",
        "Do not call another tool or retry until the user explicitly confirms this exact action.",
        "Reason: Recurring work should be confirmed.",
      ].join("\n"),
      ok: false,
      params: { cadence: "weekly" },
      toolCallId: "tool-demo",
      toolName: "demo",
    });

    await expect(
      demoTool!.execute("tool-retry", { cadence: "weekly" }),
    ).rejects.toThrow("Recurring work should be confirmed.");
    expect(review).toHaveBeenCalledTimes(2);
    expect(review.mock.calls[1]?.[0].priorRejectedActions).toEqual([
      expect.objectContaining({
        decision: "ask",
        input: { cadence: "weekly" },
        reason: "Recurring work should be confirmed.",
      }),
    ]);
    expect(
      reviewState.projectToolResult("tool-retry", { isError: true }),
    ).toMatchObject({
      details: {
        guardianActionRejection: {
          decision: "ask",
          reason: "Recurring work should be confirmed.",
        },
      },
    });

    await expect(
      demoTool!.execute("tool-limit", { cadence: "weekly" }),
    ).rejects.toThrow("Do not retry this action or an equivalent write this turn.");
    expect(review).toHaveBeenCalledTimes(3);
    expect(onFatal).not.toHaveBeenCalled();
    expect(
      reviewState.projectToolResult("tool-limit", { isError: true }),
    ).toMatchObject({
      details: {
        guardianActionRejection: {
          decision: "ask",
          reason: "Recurring work should be confirmed.",
        },
      },
      isError: true,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("escalates unavailable Guardian review to the run boundary", async () => {
    const sandbox = new SkillSandbox([], []);
    const onFatal = vi.fn();
    const reviewState = actionReview(
      {
        review: async () => {
          throw new Error("review provider unavailable");
        },
      },
      "Create the report.",
      onFatal,
    );
    const [demoTool] = createPiAgentTools(
      {
        demo: {
          approvalMode: "review",
          description: "Create the report.",
          inputSchema: {} as any,
          execute: vi.fn(),
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
      undefined,
      reviewState,
    );

    await expect(
      demoTool!.execute("tool-demo", { reportId: "weekly" }),
    ).rejects.toThrow(
      "Required action review is unavailable; the action was not executed.",
    );
    expect(onFatal).toHaveBeenCalledOnce();
  });

  it("reports thrown tool errors to observers", async () => {
    const sandbox = new SkillSandbox([], []);
    const onToolResult = vi.fn();
    const [demoTool] = createPiAgentTools(
      {
        demo: {
          description: "demo",
          inputSchema: {} as any,
          execute: async () => {
            throw new Error("Thing not found.");
          },
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

    await expect(
      demoTool!.execute("tool-demo", { id: "missing" }),
    ).rejects.toThrow("Thing not found.");

    expect(onToolResult).toHaveBeenCalledWith({
      ok: false,
      params: { id: "missing" },
      error: "Thing not found.",
      toolCallId: "tool-demo",
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

  it("serializes tools whose actions may require review", () => {
    const sandbox = new SkillSandbox([], []);
    const [automaticReviewTool, requiredReviewTool] = createPiAgentTools(
      {
        automaticReview: {
          approvalMode: "auto",
          description: "automatic review",
          inputSchema: {} as any,
          executionMode: "parallel",
          execute: async () => ({ ok: true }),
        },
        requiredReview: {
          approvalMode: "review",
          description: "required review",
          inputSchema: {} as any,
          executionMode: "parallel",
          execute: async () => ({ ok: true }),
        },
      },
      sandbox,
      {},
    );

    expect(automaticReviewTool?.executionMode).toBe("sequential");
    expect(requiredReviewTool?.executionMode).toBe("sequential");
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
      supports: (toolName: string) => toolName === "bash",
      execute: vi.fn(async () => ({
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
      supports: (toolName: string) => toolName === "bash",
      execute: vi.fn(async () => ({
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
