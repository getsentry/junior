import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";

const {
  DEMO_SKILL,
  agentInitialSystemPrompts,
  agentInitialToolNames,
  callToolMock,
  clientOptions,
  completeEmptyAssistantOnAbort,
  continueCallCount,
  continueStopsOnAbort,
  deliverPrivateMessageMock,
  listToolsMock,
  loadSkillExecutionErrorCount,
  loadSkillsByNameMock,
  omitFinalAssistantAfterTool,
  pushPreToolAssistantMessage,
  promptCallCount,
  promptMessages,
  promptSeedMessages,
  recordToolResultMessage,
  resumeMessages,
  resumeTurnContextCounts,
  searchMcpToolNames,
  turnContextInputs,
} = vi.hoisted(() => ({
  DEMO_SKILL: {
    name: "demo-skill",
    description: "Demo skill",
    skillPath: "/tmp/skills/demo-skill",
    pluginProvider: "demo",
  } as const,
  agentInitialSystemPrompts: [] as string[],
  agentInitialToolNames: [] as string[][],
  callToolMock: vi.fn(),
  clientOptions: [] as Array<Record<string, unknown>>,
  completeEmptyAssistantOnAbort: { value: false },
  continueCallCount: { value: 0 },
  continueStopsOnAbort: { value: false },
  deliverPrivateMessageMock: vi.fn(),
  listToolsMock: vi.fn(),
  loadSkillExecutionErrorCount: { value: 0 },
  loadSkillsByNameMock: vi.fn(),
  omitFinalAssistantAfterTool: { value: false },
  promptCallCount: { value: 0 },
  promptMessages: [] as unknown[],
  promptSeedMessages: [] as unknown[][],
  pushPreToolAssistantMessage: { value: false },
  recordToolResultMessage: { value: false },
  resumeMessages: [] as unknown[][],
  resumeTurnContextCounts: [] as number[],
  searchMcpToolNames: [] as string[][],
  turnContextInputs: [] as Array<{
    availableSkills?: Array<{ name: string }>;
    activeMcpCatalogs?: Array<{
      provider: string;
      available_tool_count: number;
    }>;
    includeSessionContext?: boolean;
  }>,
}));

function makeDemoLoadedSkill() {
  return {
    ...DEMO_SKILL,
    body: "Skill instructions",
  };
}

function makeDemoMcpTool(name: "ping" | "mutate") {
  return {
    name,
    title: name === "ping" ? "Ping" : "Mutate",
    description:
      name === "ping"
        ? "Ping the demo MCP server"
        : "Write through the demo MCP server",
    inputSchema: {
      type: "object",
      properties: {},
    },
  };
}

function makeDemoMcpTools() {
  return [makeDemoMcpTool("ping"), makeDemoMcpTool("mutate")];
}

function makeReplyContext(args: {
  conversationId: string;
  threadTs: string;
  turnId: string;
}) {
  return {
    requester: { userId: "U123" },
    correlation: {
      channelId: "C123",
      conversationId: args.conversationId,
      threadTs: args.threadTs,
      turnId: args.turnId,
    },
  };
}

vi.mock("@earendil-works/pi-agent-core", () => {
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
        tools: input.initialState.tools,
      };
      agentInitialSystemPrompts.push(input.initialState.systemPrompt);
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

    async prompt(message: unknown) {
      promptCallCount.value += 1;
      this.aborted = false;
      promptMessages.push(message);
      promptSeedMessages.push([...this.state.messages]);
      this.state.messages.push(message);

      const loadSkillTool = this.state.tools.find(
        (tool) => tool.name === "loadSkill",
      );
      if (!loadSkillTool) {
        throw new Error("loadSkill tool missing");
      }

      let loadSkillResult: {
        details?: {
          mcp_provider?: string;
          available_tool_count?: number;
        };
      };
      try {
        loadSkillResult = (await loadSkillTool.execute("tool-call-1", {
          skill_name: DEMO_SKILL.name,
        })) as {
          details?: {
            mcp_provider?: string;
            available_tool_count?: number;
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
      this.state.messages.push({
        role: "toolResult",
        toolCallId: "tool-call-1",
        toolName: "loadSkill",
        isError: false,
        details: loadSkillResult.details,
        content: [{ type: "text", text: "loaded" }],
      });
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
      if (loadSkillResult.details?.mcp_provider) {
        const searchMcpTools = this.state.tools.find(
          (tool) => tool.name === "searchMcpTools",
        );
        if (!searchMcpTools) {
          throw new Error("searchMcpTools missing");
        }
        const searchResult = (await searchMcpTools.execute("tool-call-search", {
          provider: loadSkillResult.details.mcp_provider,
          query: "ping query",
        })) as {
          details?: { tools?: Array<{ tool_name: string }> };
        };
        searchMcpToolNames.push(
          (searchResult.details?.tools ?? []).map((tool) => tool.tool_name),
        );
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

      const callMcpTool = this.state.tools.find(
        (tool) => tool.name === "callMcpTool",
      );
      if (!callMcpTool) {
        throw new Error("callMcpTool missing");
      }

      await callMcpTool.execute("tool-call-2", {
        tool_name: "mcp__demo__ping",
        arguments: { query: "hello" },
      });
      if (recordToolResultMessage.value) {
        this.state.messages.push({
          role: "toolResult",
          toolName: "callMcpTool",
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
      resumeMessages.push([...this.state.messages]);
      resumeTurnContextCounts.push(
        this.state.messages.filter((message) => {
          const candidate = message as { role?: unknown; content?: unknown };
          return (
            candidate.role === "user" &&
            Array.isArray(candidate.content) &&
            candidate.content.some(
              (part) =>
                part &&
                typeof part === "object" &&
                (part as { type?: unknown }).type === "text" &&
                typeof (part as { text?: unknown }).text === "string" &&
                (part as { text: string }).text.includes("Turn context"),
            )
          );
        }).length,
      );
      const lastMessage = this.state.messages[
        this.state.messages.length - 1
      ] as { role?: unknown } | undefined;
      if (lastMessage?.role === "assistant") {
        throw new Error("Cannot continue from message role: assistant");
      }
      const callMcpTool = this.state.tools.find(
        (tool) => tool.name === "callMcpTool",
      );
      if (!callMcpTool) {
        throw new Error("callMcpTool missing on continue");
      }
      await callMcpTool.execute("tool-call-continue", {
        tool_name: "mcp__demo__ping",
        arguments: { query: "hello" },
      });
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
  completeObject: async () => ({
    object: {
      thinking_level: "medium",
      confidence: 1,
      reason: "test-router",
    },
  }),
  getGatewayApiKey: () => "test-gateway-key",
  getPiGatewayApiKeyOverride: () => "test-gateway-key",
  resolveGatewayModel: (modelId: string) => modelId,
}));

vi.mock("@/chat/prompt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/prompt")>();
  return {
    ...actual,
    buildSystemPrompt: () => "System prompt",
    buildTurnContextPrompt: (input: {
      availableSkills?: Array<{ name: string }>;
      activeMcpCatalogs?: Array<{
        provider: string;
        available_tool_count: number;
      }>;
      includeSessionContext?: boolean;
    }) => {
      turnContextInputs.push(input);
      if (input.includeSessionContext === false) {
        return null;
      }
      return "<runtime-turn-context>\nTurn context\n</runtime-turn-context>";
    },
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

  return {
    ...actual,
    discoverSkills: async () => [DEMO_SKILL],
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
  getAgentTurnSessionRecord,
  upsertAgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { isRetryableTurnError } from "@/chat/runtime/turn";

// This suite validates local progressive-loading logic through a mocked
// agent/runtime seam; it is not integration coverage.
describe("generateAssistantReply progressive MCP loading", () => {
  beforeEach(async () => {
    agentInitialToolNames.length = 0;
    agentInitialSystemPrompts.length = 0;
    callToolMock.mockReset();
    clientOptions.length = 0;
    completeEmptyAssistantOnAbort.value = false;
    continueCallCount.value = 0;
    continueStopsOnAbort.value = false;
    deliverPrivateMessageMock.mockReset();
    listToolsMock.mockReset();
    searchMcpToolNames.length = 0;
    loadSkillExecutionErrorCount.value = 0;
    loadSkillsByNameMock.mockReset();
    omitFinalAssistantAfterTool.value = false;
    promptCallCount.value = 0;
    promptMessages.length = 0;
    promptSeedMessages.length = 0;
    pushPreToolAssistantMessage.value = false;
    recordToolResultMessage.value = false;
    resumeMessages.length = 0;
    resumeTurnContextCounts.length = 0;
    turnContextInputs.length = 0;

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
    loadSkillsByNameMock.mockResolvedValue([makeDemoLoadedSkill()]);
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
      .mockResolvedValue(makeDemoMcpTools());

    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    delete process.env.JUNIOR_STATE_ADAPTER;
    delete process.env.JUNIOR_BASE_URL;
    vi.restoreAllMocks();
  });

  it("persists loaded plugin skills across auth pause and resume", async () => {
    const context = makeReplyContext({
      conversationId: "conversation-1",
      threadTs: "1712345.0001",
      turnId: "turn-1",
    });

    const firstError = await generateAssistantReply("help me", context).catch(
      (error) => error,
    );

    expect(isRetryableTurnError(firstError, "mcp_auth_resume")).toBe(true);
    expect(agentInitialToolNames[0]).toContain("loadSkill");
    expect(agentInitialToolNames[0]).toContain("searchMcpTools");
    expect(agentInitialToolNames[0]).toContain("callMcpTool");
    expect(agentInitialToolNames[0]).not.toContain("searchTools");
    expect(agentInitialToolNames[0]).not.toContain("mcp__demo__ping");

    const pausedSessionRecord = await getAgentTurnSessionRecord(
      "conversation-1",
      "turn-1",
    );
    expect(pausedSessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "auth",
    });
    expect(pausedSessionRecord?.piMessages.at(-1)).toMatchObject({
      role: "toolResult",
      toolName: "loadSkill",
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
    expect(agentInitialToolNames[1]).toContain("searchMcpTools");
    expect(agentInitialToolNames[1]).toContain("callMcpTool");
    expect(agentInitialToolNames[1]).not.toContain("searchTools");
    expect(agentInitialToolNames[1]).not.toContain("mcp__demo__ping");
    expect(agentInitialSystemPrompts).toEqual([
      "System prompt",
      "System prompt",
    ]);
    expect(resumeTurnContextCounts).toEqual([1]);
    expect(turnContextInputs[0]?.includeSessionContext).toBe(true);
    expect(turnContextInputs[1]?.includeSessionContext).toBe(true);
    expect(turnContextInputs[1]?.activeMcpCatalogs).toEqual([
      { provider: "demo", available_tool_count: 1 },
    ]);
    expect(searchMcpToolNames).toEqual([]);
    expect(callToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ name: "demo" }),
      }),
      "ping",
      { query: "hello" },
    );

    const resumedSessionRecord = await getAgentTurnSessionRecord(
      "conversation-1",
      "turn-1",
    );
    expect(resumedSessionRecord).toMatchObject({
      state: "completed",
    });
  });

  it("searches loadSkill-activated MCP tools in the same turn without replay", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue(makeDemoMcpTools());

    const reply = await generateAssistantReply(
      "help me",
      makeReplyContext({
        conversationId: "conversation-2",
        threadTs: "1712345.0002",
        turnId: "turn-2",
      }),
    );

    expect(reply.text).toBe("resumed reply");
    expect(promptCallCount.value).toBe(1);
    expect(continueCallCount.value).toBe(0);
    expect(agentInitialToolNames[0]).toContain("loadSkill");
    expect(agentInitialToolNames[0]).toContain("searchMcpTools");
    expect(agentInitialToolNames[0]).toContain("callMcpTool");
    expect(agentInitialToolNames[0]).not.toContain("searchTools");
    expect(agentInitialToolNames[0]).not.toContain("mcp__demo__ping");
    expect(agentInitialSystemPrompts).toEqual(["System prompt"]);
    expect(turnContextInputs[0]?.activeMcpCatalogs).toEqual([]);
    expect(searchMcpToolNames).toEqual([["mcp__demo__ping"]]);
    expect(callToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ name: "demo" }),
      }),
      "ping",
      { query: "hello" },
    );

    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-2",
      "turn-2",
    );
    expect(sessionRecord).toMatchObject({
      state: "completed",
    });
  });

  it("restores MCP providers inferred from prior Pi history before building a follow-up turn prompt", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue(makeDemoMcpTools());

    await generateAssistantReply("help me", {
      ...makeReplyContext({
        conversationId: "conversation-restored-provider",
        threadTs: "1712345.0090",
        turnId: "turn-restored-provider",
      }),
      piMessages: [
        {
          role: "toolResult",
          toolName: "callMcpTool",
          isError: false,
          content: [{ type: "text", text: "pong" }],
          input: {
            tool_name: "mcp__demo__ping",
            arguments: { query: "prior" },
          },
        },
      ] as unknown as PiMessage[],
    });

    expect(turnContextInputs[0]?.activeMcpCatalogs).toEqual([
      { provider: "demo", available_tool_count: 1 },
    ]);
    expect(listToolsMock).toHaveBeenCalledTimes(1);
  });

  it("keeps prior Pi history and the current request when inferred provider restore pauses for auth", async () => {
    const priorMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "prior question" }],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolName: "callMcpTool",
        isError: false,
        content: [{ type: "text", text: "pong" }],
        input: {
          tool_name: "mcp__demo__ping",
          arguments: { query: "prior" },
        },
      },
    ] as unknown as PiMessage[];

    const firstError = await generateAssistantReply("current follow-up", {
      ...makeReplyContext({
        conversationId: "conversation-restore-auth",
        threadTs: "1712345.0091",
        turnId: "turn-restore-auth",
      }),
      piMessages: priorMessages,
    }).catch((error) => error);

    expect(isRetryableTurnError(firstError, "mcp_auth_resume")).toBe(true);

    const pausedSessionRecord = await getAgentTurnSessionRecord(
      "conversation-restore-auth",
      "turn-restore-auth",
    );
    expect(pausedSessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "auth",
    });
    expect(pausedSessionRecord?.piMessages).toHaveLength(3);
    expect(pausedSessionRecord?.piMessages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "prior question" }],
    });
    expect(pausedSessionRecord?.piMessages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "current follow-up" }],
    });

    const reply = await generateAssistantReply("current follow-up", {
      ...makeReplyContext({
        conversationId: "conversation-restore-auth",
        threadTs: "1712345.0091",
        turnId: "turn-restore-auth",
      }),
      piMessages: priorMessages,
    });

    expect(reply.text).toBe("resumed reply");
    expect(resumeMessages).toHaveLength(1);
    expect(resumeMessages[0]?.at(-1)).toMatchObject({
      role: "user",
      content: [
        {
          type: "text",
          text: "<runtime-turn-context>\nTurn context\n</runtime-turn-context>",
        },
        { type: "text", text: "current follow-up" },
      ],
    });
    expect(resumeTurnContextCounts).toEqual([1]);
  });

  it("injects session context when persisted Pi history has no runtime context", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue(makeDemoMcpTools());
    const priorMessages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "prior question" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "prior answer" }],
        timestamp: 2,
      },
    ] as PiMessage[];

    await generateAssistantReply("help me", {
      ...makeReplyContext({
        conversationId: "conversation-history",
        threadTs: "1712345.0003",
        turnId: "turn-history",
      }),
      conversationContext: "duplicated prior transcript",
      piMessages: priorMessages,
    });

    expect(promptSeedMessages[0]).toEqual(priorMessages);
    expect(JSON.stringify(promptMessages[0])).not.toContain(
      "duplicated prior transcript",
    );
    expect(JSON.stringify(promptMessages[0])).not.toContain(
      "<thread-background>",
    );
    expect(JSON.stringify(promptMessages[0])).toContain("Turn context");
    expect(turnContextInputs.at(-1)?.availableSkills).toEqual([
      expect.objectContaining({ name: "demo-skill" }),
    ]);
    expect(turnContextInputs.at(-1)?.includeSessionContext).toBe(true);
  });

  it("injects session context for crash retries loaded from stripped running history", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue(makeDemoMcpTools());
    const storedRunningMessages: PiMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<runtime-turn-context>\nstale bootstrap\n</runtime-turn-context>",
          },
          { type: "text", text: "prior interrupted request" },
        ],
        timestamp: 1,
      },
    ] as PiMessage[];
    const strippedHistory: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "prior interrupted request" }],
        timestamp: 1,
      },
    ] as PiMessage[];
    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-crash-retry",
      sessionId: "turn-crash-retry",
      sliceId: 1,
      state: "running",
      piMessages: storedRunningMessages,
    });

    await generateAssistantReply("continue after crash", {
      ...makeReplyContext({
        conversationId: "conversation-crash-retry",
        threadTs: "1712345.00032",
        turnId: "turn-crash-retry",
      }),
      piMessages: strippedHistory,
    });

    expect(promptSeedMessages[0]).toEqual(strippedHistory);
    expect(turnContextInputs.at(-1)?.includeSessionContext).toBe(true);
    expect(JSON.stringify(promptMessages[0])).toContain("Turn context");
    expect(JSON.stringify(promptMessages[0])).not.toContain("stale bootstrap");
  });

  it("does not duplicate session context when persisted Pi history already has it", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue(makeDemoMcpTools());
    const priorMessages: PiMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<runtime-turn-context>\nexisting bootstrap\n</runtime-turn-context>",
          },
          { type: "text", text: "prior question" },
        ],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "prior answer" }],
        timestamp: 2,
      },
    ] as PiMessage[];

    await generateAssistantReply("help me", {
      ...makeReplyContext({
        conversationId: "conversation-history-with-context",
        threadTs: "1712345.00031",
        turnId: "turn-history-with-context",
      }),
      piMessages: priorMessages,
    });

    expect(promptSeedMessages[0]).toEqual(priorMessages);
    expect(turnContextInputs.at(-1)?.includeSessionContext).toBe(false);
    expect(JSON.stringify(promptMessages[0])).not.toContain(
      "<runtime-turn-context>",
    );
  });

  it("parks for auth when MCP auth is requested during a tool call", async () => {
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
        return [makeDemoMcpTool("ping")];
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

    const context = makeReplyContext({
      conversationId: "conversation-4",
      threadTs: "1712345.0004",
      turnId: "turn-4",
    });

    const firstError = await generateAssistantReply("help me", context).catch(
      (error) => error,
    );

    expect(isRetryableTurnError(firstError, "mcp_auth_resume")).toBe(true);
    expect(deliverPrivateMessageMock).toHaveBeenCalledTimes(1);

    const pausedSessionRecord = await getAgentTurnSessionRecord(
      "conversation-4",
      "turn-4",
    );
    expect(pausedSessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "auth",
    });

    const reply = await generateAssistantReply("help me", context);

    expect(reply.text).toBe("resumed reply");

    const resumedSessionRecord = await getAgentTurnSessionRecord(
      "conversation-4",
      "turn-4",
    );
    expect(resumedSessionRecord).toMatchObject({
      state: "completed",
    });
  });

  it("does not leak provisional pre-tool assistant text as the final reply", async () => {
    pushPreToolAssistantMessage.value = true;
    recordToolResultMessage.value = true;
    omitFinalAssistantAfterTool.value = true;
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue([makeDemoMcpTool("ping")]);

    const reply = await generateAssistantReply(
      "help me",
      makeReplyContext({
        conversationId: "conversation-5",
        threadTs: "1712345.0005",
        turnId: "turn-5",
      }),
    );

    expect(reply.text).toBe("");
    expect(reply.diagnostics.outcome).toBe("execution_failure");
    expect(reply.diagnostics.usedPrimaryText).toBe(false);
  });

  it("does not return auth resume when auth session record persistence fails", async () => {
    const turnSessionStore = await import("@/chat/state/turn-session");
    const originalUpsert = turnSessionStore.upsertAgentTurnSessionRecord;
    const sessionRecordSpy = vi
      .spyOn(turnSessionStore, "upsertAgentTurnSessionRecord")
      .mockImplementation(async (args) => {
        if (args.state === "awaiting_resume" && args.resumeReason === "auth") {
          throw new Error("state adapter unavailable");
        }
        return await originalUpsert(args);
      });

    const context = {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-3",
        turnId: "turn-3",
        channelId: "C123",
        threadTs: "1712345.0003",
      },
    };

    const reply = await generateAssistantReply("help me", context);

    expect(isRetryableTurnError(reply, "mcp_auth_resume")).toBe(false);
    expect(reply.diagnostics.outcome).toBe("provider_error");
    expect(sessionRecordSpy).toHaveBeenCalled();
  });

  it("falls back to the latest stored record when auth pause captures no messages", async () => {
    continueStopsOnAbort.value = true;

    const priorMessages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "help me" }],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "tool-call-1",
        toolName: "loadSkill",
        isError: false,
        details: {
          ok: true,
          skill_name: DEMO_SKILL.name,
          mcp_provider: "demo",
        },
        content: [{ type: "text", text: "loaded" }],
        timestamp: 2,
      } as PiMessage,
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
        timestamp: 3,
        stopReason: "toolUse",
      },
    ];
    const expectedResumeMessages = priorMessages.slice(0, 2);
    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-5",
      sessionId: "turn-5",
      sliceId: 1,
      state: "awaiting_resume",
      piMessages: priorMessages,
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
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-5",
        turnId: "turn-5",
        channelId: "C123",
        threadTs: "1712345.0005",
      },
    }).catch((error) => error);

    expect(isRetryableTurnError(firstError, "mcp_auth_resume")).toBe(true);

    const resumedSessionRecord = await getAgentTurnSessionRecord(
      "conversation-5",
      "turn-5",
    );
    expect(resumedSessionRecord).toMatchObject({
      state: "awaiting_resume",
      sliceId: 2,
      resumedFromSliceId: 1,
      piMessages: expectedResumeMessages,
      resumeReason: "auth",
    });
  });

  it("still parks for auth when abort leaves an empty completed assistant frame", async () => {
    completeEmptyAssistantOnAbort.value = true;

    const firstError = await generateAssistantReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-6",
        turnId: "turn-6",
        channelId: "C123",
        threadTs: "1712345.0006",
      },
    }).catch((error) => error);

    expect(isRetryableTurnError(firstError, "mcp_auth_resume")).toBe(true);

    const pausedSessionRecord = await getAgentTurnSessionRecord(
      "conversation-6",
      "turn-6",
    );
    expect(pausedSessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "auth",
    });
    expect(pausedSessionRecord?.piMessages.at(-1)).toMatchObject({
      role: "toolResult",
      toolName: "loadSkill",
    });
  });
});
