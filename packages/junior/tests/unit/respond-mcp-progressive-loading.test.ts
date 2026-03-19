import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  agentInitialToolNames,
  callToolMock,
  clientOptions,
  continueCallCount,
  deliverPrivateMessageMock,
  listToolsMock,
  loadSkillAvailableToolNames,
  loadSkillExecutionErrorCount,
  loadSkillToolSearchFlags,
  loadSkillsByNameMock,
  promptCallCount,
} = vi.hoisted(() => ({
  agentInitialToolNames: [] as string[][],
  callToolMock: vi.fn(),
  clientOptions: [] as Array<Record<string, unknown>>,
  continueCallCount: { value: 0 },
  deliverPrivateMessageMock: vi.fn(),
  listToolsMock: vi.fn(),
  loadSkillAvailableToolNames: [] as string[][],
  loadSkillExecutionErrorCount: { value: 0 },
  loadSkillToolSearchFlags: [] as boolean[],
  loadSkillsByNameMock: vi.fn(),
  promptCallCount: { value: 0 },
}));

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
    private aborted = false;

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
      agentInitialToolNames.push(this.state.tools.map((tool) => tool.name));
    }

    subscribe() {
      return () => undefined;
    }

    abort() {
      this.aborted = true;
    }

    async replaceMessages(messages: unknown[]) {
      this.state.messages = [...messages];
    }

    async prompt(message: unknown) {
      promptCallCount.value += 1;
      this.aborted = false;
      this.state.messages.push(message);

      const loadSkillTool = this.state.tools.find(
        (tool) => tool.name === "loadSkill",
      );
      const useToolTool = this.state.tools.find(
        (tool) => tool.name === "useTool",
      );
      if (!loadSkillTool) {
        throw new Error("loadSkill tool missing");
      }
      if (!useToolTool) {
        throw new Error("useTool tool missing");
      }

      let loadSkillResult: {
        details?: {
          available_tools?: Array<{ tool_name: string }>;
          tool_search_available?: boolean;
        };
      };
      try {
        loadSkillResult = (await loadSkillTool.execute("tool-call-1", {
          skill_name: "demo-skill",
        })) as {
          details?: {
            available_tools?: Array<{ tool_name: string }>;
            tool_search_available?: boolean;
          };
        };
      } catch (error) {
        loadSkillExecutionErrorCount.value += 1;
        this.state.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "loading demo skill" }],
        });
        throw error;
      }
      const availableTools = loadSkillResult.details?.available_tools ?? [];
      loadSkillAvailableToolNames.push(
        availableTools.map((tool) => tool.tool_name),
      );
      loadSkillToolSearchFlags.push(
        loadSkillResult.details?.tool_search_available === true,
      );
      if (this.aborted) {
        this.state.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "loading demo skill" }],
        });
        return {};
      }

      const pingTool = availableTools.find(
        (tool) => tool.tool_name === "mcp__demo__ping",
      );
      if (!pingTool) {
        throw new Error("loadSkill did not disclose demo ping tool");
      }

      await useToolTool.execute("tool-call-2", {
        tool_name: pingTool.tool_name,
        arguments: { query: "hello" },
      });
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "resumed reply" }],
      });
      return {};
    }

    async continue() {
      continueCallCount.value += 1;
      const lastMessage = this.state.messages[
        this.state.messages.length - 1
      ] as { role?: unknown } | undefined;
      if (lastMessage?.role === "assistant") {
        throw new Error("Cannot continue from message role: assistant");
      }
      const useToolTool = this.state.tools.find(
        (tool) => tool.name === "useTool",
      );
      if (!useToolTool) {
        throw new Error("useTool tool missing");
      }
      await useToolTool.execute("tool-call-continue", {
        tool_name: "mcp__demo__ping",
        arguments: { query: "hello" },
      });
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "resumed reply" }],
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

vi.mock("@/chat/oauth-flow", () => ({
  deliverPrivateMessage: deliverPrivateMessageMock,
  formatProviderLabel: (provider: string) => provider,
  resolveBaseUrl: () => "https://junior.example.com",
}));

vi.mock("@/chat/mcp/oauth", () => ({
  createMcpOAuthClientProvider: async (input: {
    provider: string;
    conversationId: string;
    sessionId: string;
    userId: string;
    userMessage: string;
    channelId?: string;
    threadTs?: string;
    toolChannelId?: string;
    configuration?: Record<string, unknown>;
    artifactState?: Record<string, unknown>;
  }) => {
    const { patchMcpAuthSession, putMcpAuthSession } =
      await import("@/chat/mcp/auth-store");
    const authSessionId = `${input.provider}-auth-session`;
    await putMcpAuthSession({
      authSessionId,
      provider: input.provider,
      userId: input.userId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      userMessage: input.userMessage,
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
      ...(input.toolChannelId ? { toolChannelId: input.toolChannelId } : {}),
      ...(input.configuration ? { configuration: input.configuration } : {}),
      ...(input.artifactState ? { artifactState: input.artifactState } : {}),
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });

    return {
      authSessionId,
      redirectUrl: `https://junior.example.com/api/oauth/callback/mcp/${input.provider}`,
      clientMetadata: {
        client_name: "Junior MCP Client",
        redirect_uris: [
          `https://junior.example.com/api/oauth/callback/mcp/${input.provider}`,
        ],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      state: async () => `${input.provider}-auth-state`,
      clientInformation: async () => undefined,
      saveClientInformation: async () => undefined,
      tokens: async () => undefined,
      saveTokens: async () => undefined,
      redirectToAuthorization: async (authorizationUrl: URL) => {
        await patchMcpAuthSession(authSessionId, {
          authorizationUrl: authorizationUrl.toString(),
        });
      },
      saveCodeVerifier: async () => undefined,
      codeVerifier: async () => "code-verifier",
    };
  },
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
    createSandbox: async () => ({
      readFileToBuffer: async () =>
        Buffer.from(
          [
            "---",
            "name: demo-skill",
            "description: Demo skill",
            "---",
            "",
            "Skill instructions",
          ].join("\n"),
          "utf8",
        ),
    }),
    canExecute: () => false,
    execute: async () => {
      throw new Error("sandbox executor should not handle mocked tools");
    },
    getSandboxId: () => "sandbox-test",
    getDependencyProfileHash: () => "hash-test",
    dispose: async () => undefined,
  }),
}));

vi.mock("@/chat/plugins/registry", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/chat/plugins/registry")>();
  const plugin = {
    dir: "/tmp/plugins/demo",
    skillsDir: "/tmp/plugins/demo/skills",
    manifest: {
      name: "demo",
      description: "Demo plugin",
      capabilities: [],
      configKeys: [],
      mcp: {
        transport: "http",
        url: "https://mcp.example.com",
        allowedTools: ["ping"],
      },
    },
  };

  return {
    ...actual,
    getPluginDefinition: (provider: string) =>
      provider === "demo" ? plugin : undefined,
    getPluginMcpProviders: () => [plugin],
    getPluginProviders: () => [plugin],
  };
});

vi.mock("@/chat/skills", () => {
  const metadata = {
    name: "demo-skill",
    description: "Demo skill",
    skillPath: "/tmp/skills/demo-skill",
    pluginProvider: "demo",
  };

  return {
    discoverSkills: async () => [metadata],
    findSkillByName: () => null,
    loadSkillsByName: loadSkillsByNameMock,
    parseSkillInvocation: () => null,
  };
});

vi.mock("@/chat/mcp/client", () => {
  class MockMcpAuthorizationRequiredError extends Error {
    readonly provider: string;

    constructor(provider: string, message: string) {
      super(message);
      this.name = "McpAuthorizationRequiredError";
      this.provider = provider;
    }
  }

  class MockPluginMcpClient {
    constructor(
      private readonly plugin: { manifest: { name: string } },
      private readonly options: {
        authProvider?: {
          redirectToAuthorization?: (authorizationUrl: URL) => Promise<void>;
        };
      },
    ) {
      clientOptions.push({ ...options });
    }

    async listTools() {
      return await listToolsMock(this.plugin, this.options);
    }

    async callTool(name: string, args: Record<string, unknown>) {
      return await callToolMock(this.plugin, name, args);
    }

    async close() {}
  }

  return {
    McpAuthorizationRequiredError: MockMcpAuthorizationRequiredError,
    PluginMcpClient: MockPluginMcpClient,
  };
});

import { generateAssistantReply } from "@/chat/respond";
import {
  disconnectStateAdapter,
  getAgentTurnSessionCheckpoint,
} from "@/chat/state";
import { isRetryableTurnError } from "@/chat/turn/errors";

describe("generateAssistantReply progressive MCP loading", () => {
  beforeEach(async () => {
    agentInitialToolNames.length = 0;
    callToolMock.mockReset();
    clientOptions.length = 0;
    continueCallCount.value = 0;
    deliverPrivateMessageMock.mockReset();
    listToolsMock.mockReset();
    loadSkillAvailableToolNames.length = 0;
    loadSkillExecutionErrorCount.value = 0;
    loadSkillToolSearchFlags.length = 0;
    loadSkillsByNameMock.mockReset();
    promptCallCount.value = 0;

    process.env.JUNIOR_STATE_ADAPTER = "memory";
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";

    deliverPrivateMessageMock.mockResolvedValue({
      channel: "D123",
      threadTs: "1712345.0001",
    });
    callToolMock.mockResolvedValue({
      content: [{ type: "text", text: "pong" }],
      isError: false,
    });
    loadSkillsByNameMock.mockResolvedValue([
      {
        name: "demo-skill",
        description: "Demo skill",
        skillPath: "/tmp/skills/demo-skill",
        pluginProvider: "demo",
        allowedMcpTools: ["ping"],
        body: "Skill instructions",
      },
    ]);
    listToolsMock
      .mockImplementationOnce(
        async (
          plugin: { manifest: { name: string } },
          options: {
            authProvider?: {
              redirectToAuthorization?: (
                authorizationUrl: URL,
              ) => Promise<void>;
            };
          },
        ) => {
          await options.authProvider?.redirectToAuthorization?.(
            new URL(`https://auth.example.com/${plugin.manifest.name}`),
          );
          const { McpAuthorizationRequiredError } =
            await import("@/chat/mcp/client");
          throw new McpAuthorizationRequiredError(
            plugin.manifest.name,
            "Auth required",
          );
        },
      )
      .mockResolvedValue([
        {
          name: "ping",
          title: "Ping",
          description: "Ping the demo MCP server",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "mutate",
          title: "Mutate",
          description: "Write through the demo MCP server",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ]);

    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    delete process.env.JUNIOR_STATE_ADAPTER;
    delete process.env.JUNIOR_BASE_URL;
    vi.restoreAllMocks();
  });

  it("persists loaded plugin skills across auth pause and resume", async () => {
    const context = {
      assistant: { userName: "junior" },
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-1",
        turnId: "turn-1",
        channelId: "C123",
        threadTs: "1712345.0001",
      },
    };

    const firstError = await generateAssistantReply("help me", context).catch(
      (error) => error,
    );

    expect(isRetryableTurnError(firstError, "mcp_auth_resume")).toBe(true);
    expect(agentInitialToolNames[0]).toContain("loadSkill");
    expect(agentInitialToolNames[0]).toContain("searchTools");
    expect(agentInitialToolNames[0]).toContain("useTool");
    expect(agentInitialToolNames[0]).not.toContain("mcp__demo__ping");

    const pausedCheckpoint = await getAgentTurnSessionCheckpoint(
      "conversation-1",
      "turn-1",
    );
    expect(pausedCheckpoint).toMatchObject({
      state: "awaiting_resume",
      loadedSkillNames: ["demo-skill"],
      resumeReason: "auth",
    });
    expect(pausedCheckpoint?.piMessages.at(-1)).toMatchObject({
      role: "user",
    });
    expect(deliverPrivateMessageMock).toHaveBeenCalledTimes(1);
    expect(loadSkillExecutionErrorCount.value).toBe(0);

    const reply = await generateAssistantReply("help me", context);

    expect(reply.text).toBe("resumed reply");
    expect(promptCallCount.value).toBe(1);
    expect(continueCallCount.value).toBe(1);
    expect(clientOptions).not.toContainEqual(
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
    expect(agentInitialToolNames[1]).toContain("loadSkill");
    expect(agentInitialToolNames[1]).toContain("searchTools");
    expect(agentInitialToolNames[1]).toContain("useTool");
    expect(agentInitialToolNames[1]).not.toContain("mcp__demo__ping");
    expect(loadSkillAvailableToolNames).toEqual([[]]);
    expect(loadSkillToolSearchFlags).toEqual([false]);
    expect(callToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ name: "demo" }),
      }),
      "ping",
      { query: "hello" },
    );

    const resumedCheckpoint = await getAgentTurnSessionCheckpoint(
      "conversation-1",
      "turn-1",
    );
    expect(resumedCheckpoint).toMatchObject({
      state: "completed",
      loadedSkillNames: ["demo-skill"],
    });
  });

  it("uses loadSkill-disclosed MCP tools in the same turn without replay", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue([
      {
        name: "ping",
        title: "Ping",
        description: "Ping the demo MCP server",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "mutate",
        title: "Mutate",
        description: "Write through the demo MCP server",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ]);

    const reply = await generateAssistantReply("help me", {
      assistant: { userName: "junior" },
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-2",
        turnId: "turn-2",
        channelId: "C123",
        threadTs: "1712345.0002",
      },
    });

    expect(reply.text).toBe("resumed reply");
    expect(promptCallCount.value).toBe(1);
    expect(continueCallCount.value).toBe(0);
    expect(agentInitialToolNames[0]).toContain("loadSkill");
    expect(agentInitialToolNames[0]).toContain("searchTools");
    expect(agentInitialToolNames[0]).toContain("useTool");
    expect(agentInitialToolNames[0]).not.toContain("mcp__demo__ping");
    expect(loadSkillAvailableToolNames).toEqual([["mcp__demo__ping"]]);
    expect(loadSkillToolSearchFlags).toEqual([true]);
    expect(callToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ name: "demo" }),
      }),
      "ping",
      { query: "hello" },
    );

    const checkpoint = await getAgentTurnSessionCheckpoint(
      "conversation-2",
      "turn-2",
    );
    expect(checkpoint).toMatchObject({
      state: "completed",
      loadedSkillNames: ["demo-skill"],
    });
  });
});
