import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-agent-core", () => {
  class MockAgent {
    state: {
      messages: unknown[];
      model: unknown;
      systemPrompt: string;
      tools: Array<{
        name: string;
        execute: (toolCallId: unknown, params: unknown) => Promise<unknown>;
      }>;
    };

    constructor(input: {
      initialState: {
        model: unknown;
        systemPrompt: string;
        tools: Array<{
          name: string;
          execute: (toolCallId: unknown, params: unknown) => Promise<unknown>;
        }>;
      };
    }) {
      this.state = {
        messages: [],
        model: input.initialState.model,
        systemPrompt: input.initialState.systemPrompt,
        tools: [...input.initialState.tools],
      };
    }

    subscribe() {
      return () => undefined;
    }

    abort() {}

    async prompt(message: unknown) {
      this.state.messages.push(message);

      const bashTool = this.state.tools.find((tool) => tool.name === "bash");
      if (!bashTool) {
        throw new Error("bash tool missing");
      }

      const result = (await bashTool.execute("tool-call-1", {
        command: "jr-rpc issue-credential eval-oauth.read",
      })) as { content?: unknown; details?: unknown };

      this.state.messages.push({
        role: "toolResult",
        toolName: "bash",
        isError: false,
        content: Array.isArray(result.content) ? result.content : [],
        details: result.details,
      });

      return {};
    }
  }

  return { Agent: MockAgent };
});

vi.mock("@/chat/observability", () => ({
  logException: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  setSpanAttributes: vi.fn(),
  setSpanStatus: vi.fn(),
  setTags: vi.fn(),
  withSpan: async (
    _name: string,
    _op: string,
    _context: unknown,
    callback: () => Promise<unknown>,
  ) => await callback(),
}));

vi.mock("@/chat/pi/client", () => ({
  GEN_AI_PROVIDER_NAME: "vercel-ai-gateway",
  getGatewayApiKey: () => "test-gateway-key",
  resolveGatewayModel: (modelId: string) => modelId,
}));

vi.mock("@/chat/prompt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/prompt")>();
  return {
    ...actual,
    buildSystemPrompt: () => "System prompt",
  };
});

vi.mock("@/chat/runtime/dev-agent-trace", () => ({
  shouldEmitDevAgentTrace: () => false,
}));

vi.mock("@/chat/runtime-metadata", () => ({
  getRuntimeMetadata: () => ({ version: "test" }),
}));

vi.mock("@/chat/capabilities/factory", () => ({
  createSkillCapabilityRuntime: () => ({
    getTurnHeaderTransforms: () => undefined,
    getTurnEnv: () => undefined,
  }),
  getUserTokenStore: () => ({
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined,
  }),
}));

vi.mock("@/chat/capabilities/jr-rpc-command", () => ({
  maybeExecuteJrRpcCustomCommand: async () => ({ handled: false }),
}));

vi.mock("@/chat/sandbox/sandbox", () => ({
  createSandboxExecutor: () => ({
    configureSkills: () => undefined,
    createSandbox: async () => ({}),
    canExecute: (toolName: string) => toolName === "bash",
    execute: async () => ({
      result: {
        ok: true,
        exit_code: 0,
        duration_ms: 1,
        stdout: `${JSON.stringify(
          {
            credential_unavailable: true,
            oauth_started: true,
            provider: "eval-oauth",
            private_delivery_sent: true,
            message:
              "I need to connect your Eval-oauth account first. I've sent you a private authorization link.",
          },
          null,
          2,
        )}\n`,
        stderr: "",
        stdout_truncated: false,
        stderr_truncated: false,
      },
    }),
    getSandboxId: () => "sandbox-test",
    getDependencyProfileHash: () => "hash-test",
    dispose: async () => undefined,
  }),
}));

vi.mock("@/chat/plugins/registry", () => ({
  getPluginMcpProviders: () => [],
  getPluginProviders: () => [],
}));

vi.mock("@/chat/skills", () => ({
  discoverSkills: async () => [],
  findSkillByName: () => null,
  loadSkillsByName: async () => [],
  parseSkillInvocation: () => null,
}));

import { generateAssistantReply } from "@/chat/respond";

describe("generateAssistantReply generic OAuth start fallback", () => {
  it("uses the oauth-started message when the model emits no assistant text", async () => {
    const reply = await generateAssistantReply(
      "Connect the demo account, then tell me what budget deadline I mentioned earlier.",
      {
        requester: { userId: "U_TEST" },
        correlation: {
          channelId: "C_TEST",
          threadTs: "1700000000.0001",
          requesterId: "U_TEST",
        },
      },
    );

    expect(reply.text).toBe(
      "I need to connect your Eval-oauth account first. I've sent you a private authorization link.",
    );
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(false);
    expect(reply.diagnostics.toolResultCount).toBe(1);
    expect(reply.diagnostics.toolErrorCount).toBe(0);
  });
});
