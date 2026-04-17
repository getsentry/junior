import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

const {
  agentInitialToolNames,
  callToolMock,
  clientOptions,
  completeEmptyAssistantOnAbort,
  continueCallCount,
  continueStopsOnAbort,
  deliverPrivateMessageMock,
  ignoreReplaceMessages,
  listToolsMock,
  loadSkillAvailableToolNames,
  loadSkillExecutionErrorCount,
  loadSkillsByNameMock,
  omitFinalAssistantAfterTool,
  pushPreToolAssistantMessage,
  promptCallCount,
  recordToolResultMessage,
} = vi.hoisted(() => ({
  agentInitialToolNames: [] as string[][],
  callToolMock: vi.fn(),
  clientOptions: [] as Array<Record<string, unknown>>,
  completeEmptyAssistantOnAbort: { value: false },
  continueCallCount: { value: 0 },
  continueStopsOnAbort: { value: false },
  deliverPrivateMessageMock: vi.fn(),
  ignoreReplaceMessages: { value: false },
  listToolsMock: vi.fn(),
  loadSkillAvailableToolNames: [] as string[][],
  loadSkillExecutionErrorCount: { value: 0 },
  loadSkillsByNameMock: vi.fn(),
  omitFinalAssistantAfterTool: { value: false },
  promptCallCount: { value: 0 },
  pushPreToolAssistantMessage: { value: false },
  recordToolResultMessage: { value: false },
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
        // Keep the same array reference so in-place mutations from
        // syncMcpAgentTools() are visible (matches pi-agent-core behavior).
        tools: input.initialState.tools,
      };
      agentInitialToolNames.push(
        input.initialState.tools.map((tool) => tool.name),
      );
    }

    subscribe() {
      return () => undefined;
    }

    abort() {
      this.aborted = true;
    }

    async replaceMessages(messages: unknown[]) {
      if (ignoreReplaceMessages.value) {
        return;
      }
      this.state.messages = [...messages];
    }

    async prompt(message: unknown) {
      promptCallCount.value += 1;
      this.aborted = false;
      this.state.messages.push(message);

      const loadSkillTool = this.state.tools.find(
        (tool) => tool.name === "loadSkill",
      );
      if (!loadSkillTool) {
        throw new Error("loadSkill tool missing");
      }

      let loadSkillResult: {
        details?: {
          available_tools?: Array<{ tool_name: string }>;
        };
      };
      try {
        loadSkillResult = (await loadSkillTool.execute("tool-call-1", {
          skill_name: "demo-skill",
        })) as {
          details?: {
            available_tools?: Array<{ tool_name: string }>;
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
      if (this.aborted) {
        this.state.messages.push({
          role: "assistant",
          content: [
            {
              type: "text",
              text: completeEmptyAssistantOnAbort.value
                ? ""
                : "loading demo skill",
            },
          ],
          ...(completeEmptyAssistantOnAbort.value
            ? { stopReason: "stop" }
            : {}),
        });
        return {};
      }

      if (pushPreToolAssistantMessage.value) {
        this.state.messages.push({
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Let me search for related articles and compare perspectives.",
            },
          ],
        });
      }

      // After loadSkill, MCP tools are registered as first-class tools
      // on the shared tools array via syncMcpAgentTools().
      const mcpPingTool = this.state.tools.find(
        (tool) => tool.name === "mcp__demo__ping",
      );
      if (!mcpPingTool) {
        throw new Error(
          "mcp__demo__ping not registered after loadSkill. Tools: " +
            this.state.tools.map((t) => t.name).join(", "),
        );
      }

      await mcpPingTool.execute("tool-call-2", { query: "hello" });
      if (recordToolResultMessage.value) {
        this.state.messages.push({
          role: "toolResult",
          toolName: "mcp__demo__ping",
          isError: false,
          content: [{ type: "text", text: "pong" }],
        });
      }
      if (omitFinalAssistantAfterTool.value) {
        return {};
      }
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "resumed reply" }],
        stopReason: "stop",
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
      const mcpPingTool = this.state.tools.find(
        (tool) => tool.name === "mcp__demo__ping",
      );
      if (!mcpPingTool) {
        throw new Error("mcp__demo__ping tool missing on continue");
      }
      await mcpPingTool.execute("tool-call-continue", { query: "hello" });
      if (this.aborted && continueStopsOnAbort.value) {
        return {};
      }
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "resumed reply" }],
        stopReason: "stop",
      });
      return {};
    }
  }

  return { Agent: MockAgent };
});

vi.mock("@/chat/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/logging")>()),
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

vi.mock("@/chat/oauth-flow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/oauth-flow")>()),
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

vi.mock("@/chat/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/chat/config")>();
  const memoryConfig = original.readChatConfig({
    ...process.env,
    JUNIOR_STATE_ADAPTER: "memory",
  });
  return {
    ...original,
    botConfig: memoryConfig.bot,
    getChatConfig: () => memoryConfig,
    getRuntimeMetadata: () => ({ version: "test" }),
  };
});

vi.mock("@/chat/capabilities/factory", () => ({
  createSkillCapabilityRuntime: () => ({
    getTurnHeaderTransforms: () => undefined,
  }),
  createUserTokenStore: () => ({
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
    configureReferenceFiles: () => undefined,
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

vi.mock("@/chat/skills", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/skills")>();
  const metadata = {
    name: "demo-skill",
    description: "Demo skill",
    skillPath: "/tmp/skills/demo-skill",
    pluginProvider: "demo",
  };

  return {
    ...actual,
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
  getAgentTurnSessionCheckpoint,
  upsertAgentTurnSessionCheckpoint,
} from "@/chat/state/turn-session-store";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { isRetryableTurnError } from "@/chat/runtime/turn";

describe("generateAssistantReply progressive MCP loading", () => {
  beforeEach(async () => {
    agentInitialToolNames.length = 0;
    callToolMock.mockReset();
    clientOptions.length = 0;
    completeEmptyAssistantOnAbort.value = false;
    continueCallCount.value = 0;
    continueStopsOnAbort.value = false;
    deliverPrivateMessageMock.mockReset();
    ignoreReplaceMessages.value = false;
    listToolsMock.mockReset();
    loadSkillAvailableToolNames.length = 0;
    loadSkillExecutionErrorCount.value = 0;
    loadSkillsByNameMock.mockReset();
    omitFinalAssistantAfterTool.value = false;
    promptCallCount.value = 0;
    pushPreToolAssistantMessage.value = false;
    recordToolResultMessage.value = false;

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
    // On resume, pre-loaded skills activate MCP tools at init time.
    expect(agentInitialToolNames[1]).toContain("mcp__demo__ping");
    expect(loadSkillAvailableToolNames).toEqual([[]]);
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
    expect(agentInitialToolNames[0]).not.toContain("mcp__demo__ping");
    expect(loadSkillAvailableToolNames).toEqual([["mcp__demo__ping"]]);
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

  it("keeps a completed turn when MCP auth is requested during a tool call", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockImplementation(
      async (
        plugin: { manifest: { name: string } },
        options: {
          authProvider?: {
            redirectToAuthorization?: (authorizationUrl: URL) => Promise<void>;
          };
        },
      ) => {
        await options.authProvider?.redirectToAuthorization?.(
          new URL(`https://auth.example.com/${plugin.manifest.name}`),
        );
        return [
          {
            name: "ping",
            title: "Ping",
            description: "Ping the demo MCP server",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
        ];
      },
    );
    callToolMock.mockImplementationOnce(async (plugin) => {
      const { McpAuthorizationRequiredError } =
        await import("@/chat/mcp/client");
      throw new McpAuthorizationRequiredError(
        plugin.manifest.name,
        "Auth required",
      );
    });

    const reply = await generateAssistantReply("help me", {
      assistant: { userName: "junior" },
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-4",
        turnId: "turn-4",
        channelId: "C123",
        threadTs: "1712345.0004",
      },
    });

    expect(reply.text).toBe("resumed reply");
    expect(deliverPrivateMessageMock).toHaveBeenCalledTimes(1);

    const checkpoint = await getAgentTurnSessionCheckpoint(
      "conversation-4",
      "turn-4",
    );
    expect(checkpoint).toMatchObject({
      state: "completed",
      loadedSkillNames: ["demo-skill"],
    });
  });

  it("does not leak provisional pre-tool assistant text as the final reply", async () => {
    pushPreToolAssistantMessage.value = true;
    recordToolResultMessage.value = true;
    omitFinalAssistantAfterTool.value = true;
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
    ]);

    const reply = await generateAssistantReply("help me", {
      assistant: { userName: "junior" },
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-5",
        turnId: "turn-5",
        channelId: "C123",
        threadTs: "1712345.0005",
      },
    });

    expect(reply.text).toBe(
      "I couldn't complete this request in this turn due to an execution failure. I've logged the details for debugging.",
    );
    expect(reply.diagnostics.outcome).toBe("execution_failure");
    expect(reply.diagnostics.usedPrimaryText).toBe(false);
  });

  it("still returns auth resume when auth checkpoint persistence fails", async () => {
    const checkpointSpy = vi
      .spyOn(
        await import("@/chat/state/turn-session-store"),
        "upsertAgentTurnSessionCheckpoint",
      )
      .mockImplementationOnce(async () => {
        throw new Error("state adapter unavailable");
      });

    const context = {
      assistant: { userName: "junior" },
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-3",
        turnId: "turn-3",
        channelId: "C123",
        threadTs: "1712345.0003",
      },
    };

    const firstError = await generateAssistantReply("help me", context).catch(
      (error) => error,
    );

    expect(isRetryableTurnError(firstError, "mcp_auth_resume")).toBe(true);
    expect(checkpointSpy).toHaveBeenCalled();
  });

  it("falls back to the latest stored checkpoint when auth pause captures no messages", async () => {
    ignoreReplaceMessages.value = true;
    continueStopsOnAbort.value = true;

    const priorMessages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "help me" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "working on it" }],
        api: "responses",
        provider: "openai",
        model: "gpt-5.3",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        timestamp: 2,
        stopReason: "toolUse",
      },
    ];
    const expectedResumeMessages = [priorMessages[0]];
    await upsertAgentTurnSessionCheckpoint({
      conversationId: "conversation-5",
      sessionId: "turn-5",
      sliceId: 1,
      state: "awaiting_resume",
      piMessages: priorMessages,
      loadedSkillNames: ["demo-skill"],
      resumeReason: "auth",
    });

    callToolMock.mockImplementationOnce(async (plugin) => {
      const { McpAuthorizationRequiredError } =
        await import("@/chat/mcp/client");
      throw new McpAuthorizationRequiredError(
        plugin.manifest.name,
        "Auth required",
      );
    });

    const firstError = await generateAssistantReply("help me", {
      assistant: { userName: "junior" },
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-5",
        turnId: "turn-5",
        channelId: "C123",
        threadTs: "1712345.0005",
      },
    }).catch((error) => error);

    expect(isRetryableTurnError(firstError, "mcp_auth_resume")).toBe(true);

    const resumedCheckpoint = await getAgentTurnSessionCheckpoint(
      "conversation-5",
      "turn-5",
    );
    expect(resumedCheckpoint).toMatchObject({
      state: "awaiting_resume",
      sliceId: 2,
      resumedFromSliceId: 1,
      piMessages: expectedResumeMessages,
      loadedSkillNames: ["demo-skill"],
      resumeReason: "auth",
    });
  });

  it("still parks for auth when abort leaves an empty completed assistant frame", async () => {
    completeEmptyAssistantOnAbort.value = true;

    const firstError = await generateAssistantReply("help me", {
      assistant: { userName: "junior" },
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-6",
        turnId: "turn-6",
        channelId: "C123",
        threadTs: "1712345.0006",
      },
    }).catch((error) => error);

    expect(isRetryableTurnError(firstError, "mcp_auth_resume")).toBe(true);

    const pausedCheckpoint = await getAgentTurnSessionCheckpoint(
      "conversation-6",
      "turn-6",
    );
    expect(pausedCheckpoint).toMatchObject({
      state: "awaiting_resume",
      loadedSkillNames: ["demo-skill"],
      resumeReason: "auth",
    });
    expect(pausedCheckpoint?.piMessages.at(-1)).toMatchObject({
      role: "user",
    });
  });
});
