import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { renderCurrentInstruction } from "@/chat/current-instruction";
import { getConversationEventStore } from "@/chat/db";
import { McpProviderError } from "@/chat/mcp/errors";
import type { PiMessage } from "@/chat/pi/messages";
import type { ConversationPendingAuthState } from "@/chat/state/conversation";

const {
  DEMO_SKILL,
  agentAfterToolResults,
  agentInitialSystemPrompts,
  agentInitialToolNames,
  callToolMock,
  clientOptions,
  completeEmptyAssistantOnAbort,
  continueCallCount,
  continueStopsOnAbort,
  deliverPrivateMessageMock,
  directMcpProviderFailure,
  guardianDecision,
  guardianProposals,
  listToolsMock,
  loadSkillExecutionErrorCount,
  loadSkillsByNameMock,
  incrementStatMock,
  pendingAuthRecords,
  promptCallCount,
  promptMessages,
  promptSeedMessages,
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
  agentAfterToolResults: [] as unknown[],
  agentInitialSystemPrompts: [] as string[],
  agentInitialToolNames: [] as string[][],
  callToolMock: vi.fn(),
  clientOptions: [] as Array<Record<string, unknown>>,
  completeEmptyAssistantOnAbort: { value: false },
  continueCallCount: { value: 0 },
  continueStopsOnAbort: { value: false },
  deliverPrivateMessageMock: vi.fn(),
  directMcpProviderFailure: { value: false },
  guardianDecision: {
    value: "allow" as "allow" | "deny" | "unavailable",
  },
  guardianProposals: [] as unknown[],
  listToolsMock: vi.fn(),
  loadSkillExecutionErrorCount: { value: 0 },
  loadSkillsByNameMock: vi.fn(),
  incrementStatMock: vi.fn(),
  pendingAuthRecords: [] as ConversationPendingAuthState[],
  promptCallCount: { value: 0 },
  promptMessages: [] as unknown[],
  promptSeedMessages: [] as unknown[][],
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

const TEST_ACTOR = {
  platform: "slack",
  teamId: "T123",
  userId: "U123",
} as const;

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
  function assistantMessage(text: string) {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

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
    private readonly afterToolCall?: (
      event: {
        isError: boolean;
        result: { content: unknown[]; details: Record<string, unknown> };
        toolCall: { arguments: unknown; id: string; name: string };
      },
      signal?: AbortSignal,
    ) => Promise<
      | {
          content?: unknown[];
          details?: Record<string, unknown>;
          isError?: boolean;
        }
      | undefined
    >;

    constructor(input: {
      afterToolCall?: MockAgent["afterToolCall"];
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
      this.afterToolCall = input.afterToolCall;
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

    private async executeTool(
      tool: {
        name: string;
        execute: (toolCallId: unknown, params: unknown) => Promise<unknown>;
      },
      toolCallId: string,
      params: Record<string, unknown>,
    ) {
      try {
        return await tool.execute(toolCallId, params);
      } catch (error) {
        const result = {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          details: {},
        };
        const adjusted = await this.afterToolCall?.({
          isError: true,
          result,
          toolCall: {
            arguments: params,
            id: toolCallId,
            name: tool.name,
          },
        });
        agentAfterToolResults.push(adjusted ?? result);
        throw error;
      }
    }

    async prompt(message: unknown) {
      promptCallCount.value += 1;
      this.aborted = false;
      promptMessages.push(message);
      promptSeedMessages.push([...this.state.messages]);
      this.state.messages.push(message);

      if (directMcpProviderFailure.value) {
        const searchMcpTools = this.state.tools.find(
          (tool) => tool.name === "searchMcpTools",
        );
        if (!searchMcpTools) {
          throw new Error("searchMcpTools missing");
        }
        try {
          await this.executeTool(searchMcpTools, "tool-search-provider-failure", {
            provider: "demo",
            query: "ping query",
          });
        } catch {
          if (!this.aborted) {
            this.state.messages.push(
              assistantMessage("I couldn't connect to the demo provider."),
            );
          }
          return {};
        }
      }

      const loadSkillTool = this.state.tools.find(
        (tool) => tool.name === "loadSkill",
      );
      if (!loadSkillTool) {
        throw new Error("loadSkill tool missing");
      }

      let loadSkillResult: { details?: unknown };
      try {
        loadSkillResult = (await loadSkillTool.execute("tool-call-1", {
          skill_name: DEMO_SKILL.name,
        })) as { details?: unknown };
      } catch (error) {
        loadSkillExecutionErrorCount.value += 1;
        this.state.messages.push(assistantMessage("loading demo skill"));
        throw error;
      }
      this.state.messages.push({
        role: "toolResult",
        toolCallId: "tool-call-1",
        toolName: "loadSkill",
        isError: false,
        details: loadSkillResult.details,
        content: [{ type: "text", text: "loaded" }],
        timestamp: Date.now(),
      });
      if (this.aborted) {
        this.state.messages.push(
          assistantMessage(
            completeEmptyAssistantOnAbort.value ? "" : "loading demo skill",
          ),
        );
        return {};
      }
      const searchMcpTools = this.state.tools.find(
        (tool) => tool.name === "searchMcpTools",
      );
      if (!searchMcpTools) {
        throw new Error("searchMcpTools missing");
      }
      const searchResult = (await searchMcpTools.execute("tool-call-search", {
        provider: "demo",
        query: "ping query",
      })) as {
        details?: { tools?: Array<{ tool_name: string }> };
      };
      searchMcpToolNames.push(
        (searchResult.details?.tools ?? []).map((tool) => tool.tool_name),
      );
      const callMcpTool = this.state.tools.find(
        (tool) => tool.name === "callMcpTool",
      );
      if (!callMcpTool) {
        throw new Error("callMcpTool missing");
      }

      await this.executeTool(callMcpTool, "tool-call-2", {
        tool_name: "mcp__demo__ping",
        arguments: { query: "hello" },
      });
      this.state.messages.push(assistantMessage("resumed reply"));
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
      const searchMcpTools = this.state.tools.find(
        (tool) => tool.name === "searchMcpTools",
      );
      if (!searchMcpTools) {
        throw new Error("searchMcpTools missing on continue");
      }
      await this.executeTool(searchMcpTools, "tool-search-continue", {
        provider: "demo",
        query: "ping query",
      });
      const callMcpTool = this.state.tools.find(
        (tool) => tool.name === "callMcpTool",
      );
      if (!callMcpTool) {
        throw new Error("callMcpTool missing on continue");
      }
      await this.executeTool(callMcpTool, "tool-call-continue", {
        tool_name: "mcp__demo__ping",
        arguments: { query: "hello" },
      });
      if (this.aborted && continueStopsOnAbort.value) {
        return {};
      }
      this.state.messages.push(assistantMessage("resumed reply"));
      return {};
    }
  }

  return { ...actual, Agent: MockAgent };
});

vi.mock("@/chat/oauth-flow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/oauth-flow")>()),
  deliverOAuthAuthorization: async (
    _request: unknown,
    input: { channelId?: string; threadTs?: string; userId: string },
  ) => await deliverPrivateMessageMock(input),
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
  }) => {
    const { patchMcpAuthSession, putMcpAuthSession } =
      await import("@/chat/mcp/auth-store");
    const authSessionId = `${input.provider}-auth-session`;
    await putMcpAuthSession({
      schemaVersion: 2,
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
  GEN_AI_SERVER_ADDRESS: "ai-gateway.vercel.sh",
  GEN_AI_SERVER_PORT: 443,
  completeObject: async () => ({
    object: {
      reasoning_level: "medium",
      profile: "standard",
      confidence: 1,
      reason: "test-router",
    },
  }),
  getGatewayApiKey: () => "test-gateway-key",
  resolveGatewayModel: (modelId: string) => modelId,
}));

vi.mock("@/chat/services/guardian-action-review", () => ({
  createGuardianActionReviewer: () => ({
    review: async (proposal: unknown) => {
      guardianProposals.push(proposal);
      if (guardianDecision.value === "unavailable") {
        throw new Error("guardian provider unavailable");
      }
      return guardianDecision.value === "deny"
        ? {
            decision: "deny" as const,
            reason: "The test policy denied this action.",
            riskLevel: "high" as const,
            userAuthorization: "low" as const,
          }
        : {
            decision: "allow" as const,
            reason: "This test exercises MCP runtime behavior.",
            riskLevel: "low" as const,
            userAuthorization: "high" as const,
          };
    },
  }),
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
    withRefresh: async <T>(
      _userId: string,
      _provider: string,
      callback: () => Promise<T>,
    ) => callback(),
  }),
}));

vi.mock("@/chat/capabilities/jr-rpc-command", () => ({
  maybeExecuteJrRpcCustomCommand: async () => ({ handled: false }),
}));

vi.mock("@/chat/sandbox/sandbox", () => ({
  createSandbox: () => ({
    captureRepositoryInstructions: async () => undefined,
    workspace: {
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
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      writeFiles: async () => undefined,
    },
    tools: {
      supports: () => false,
      execute: async () => {
        throw new Error("sandbox executor should not handle mocked tools");
      },
    },
    sandboxRef: () => ({ id: "sandbox-test", profileHash: "hash-test" }),
    close: vi.fn(),
  }),
}));

vi.mock("@/chat/plugins/catalog-runtime", () => {
  const plugin = {
    dir: "/tmp/plugins/demo",
    skillsDir: "/tmp/plugins/demo/skills",
    manifest: {
      name: "demo",
      description: "Demo plugin",
      configKeys: [],
      mcp: {
        transport: "http",
        url: "https://mcp.example.com",
        allowedTools: ["ping"],
      },
    },
  };

  return {
    pluginCatalogRuntime: {
      getDefinition: (provider: string) =>
        provider === "demo" ? plugin : undefined,
      getMcpProviders: () => [plugin],
      getProviders: () => [plugin],
    },
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

vi.mock("@/stats", () => ({
  incrementStat: incrementStatMock,
}));

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

import { executeAgentRun } from "@/chat/agent";
import type { AgentRun } from "@/chat/agent/types";
import { botConfig } from "@/chat/config";
import { recordMcpProviderConnected } from "@/chat/conversations/projection";
import { TurnSliceLimitExceededError } from "@/chat/services/turn-limit";
import {
  getTurnRecord,
  upsertTurnRecord,
} from "@/chat/task-execution/turn-cursor";
import { disconnectStateAdapter } from "@/chat/state/adapter";

function finalReply(outcome: Awaited<ReturnType<typeof executeAgentRun>>) {
  if (outcome.status !== "completed") {
    throw new Error(`Expected final reply, got ${outcome.status}`);
  }
  return outcome.result;
}

function makeAgentRun(
  messageText: string,
  args: {
    conversationId: string;
    threadTs: string;
    turnId: string;
  },
  overrides: {
    instruction?: Partial<Omit<AgentRun["instruction"], "text">>;
    history?: AgentRun["history"];
    state?: AgentRun["state"];
    onEvent?: AgentRun["onEvent"];
    durability?: AgentRun["durability"];
  } & Partial<
    Omit<
      AgentRun,
      | "conversationId"
      | "turnId"
      | "instruction"
      | "history"
      | "state"
      | "onEvent"
      | "durability"
      | "delivery"
    >
  > = {},
): AgentRun {
  const destination = {
    platform: "slack" as const,
    teamId: "T123",
    channelId: "C123",
  };
  const {
    instruction: instructionOverrides,
    history,
    state,
    onEvent,
    durability: durabilityOverrides,
    ...runOverrides
  } = overrides;
  return {
    conversationId: args.conversationId,
    turnId: args.turnId,
    instruction: {
      text: messageText,
      ...(instructionOverrides ?? {}),
    },
    ...(history ? { history } : {}),
    destinationVisibility: "private",
    credentialContext: {
      actor: { type: "user" as const, userId: "U123" },
    },
    destination,
    source: createSlackSource({
      teamId: destination.teamId,
      channelId: destination.channelId,
      threadTs: args.threadTs,
      visibility: "private",
    }),
    actor: TEST_ACTOR,
    ...runOverrides,
    ...(state ? { state } : {}),
    ...(onEvent ? { onEvent } : {}),
    durability: {
      recordPendingAuth: async (pendingAuth) => {
        if (pendingAuth) {
          pendingAuthRecords.push(pendingAuth);
        }
      },
      ...(durabilityOverrides ?? {}),
    },
  };
}

// This suite validates local progressive-loading logic through a mocked
// agent/runtime seam; it is not integration coverage.
describe("executeAgentRun progressive MCP loading", () => {
  beforeEach(async () => {
    agentInitialToolNames.length = 0;
    agentInitialSystemPrompts.length = 0;
    agentAfterToolResults.length = 0;
    callToolMock.mockReset();
    clientOptions.length = 0;
    completeEmptyAssistantOnAbort.value = false;
    continueCallCount.value = 0;
    continueStopsOnAbort.value = false;
    deliverPrivateMessageMock.mockReset();
    directMcpProviderFailure.value = false;
    guardianDecision.value = "allow";
    guardianProposals.length = 0;
    listToolsMock.mockReset();
    searchMcpToolNames.length = 0;
    loadSkillExecutionErrorCount.value = 0;
    loadSkillsByNameMock.mockReset();
    incrementStatMock.mockReset();
    pendingAuthRecords.length = 0;
    promptCallCount.value = 0;
    promptMessages.length = 0;
    promptSeedMessages.length = 0;
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

  it("continues an MCP skill call across auth pause and resume", async () => {
    const context = makeAgentRun("help me", {
      conversationId: "conversation-1",
      threadTs: "1712345.0001",
      turnId: "turn-1",
    });

    const firstError = await executeAgentRun(context);

    expect(firstError.status).toBe("awaiting_auth");
    expect(agentInitialToolNames[0]).toContain("loadSkill");
    expect(agentInitialToolNames[0]).toContain("searchMcpTools");
    expect(agentInitialToolNames[0]).toContain("callMcpTool");
    expect(agentInitialToolNames[0]).toContain("searchTools");
    expect(agentInitialToolNames[0]).toContain("executeTool");
    expect(agentInitialToolNames[0]).not.toContain("mcp__demo__ping");

    const pausedSessionRecord = await getTurnRecord("conversation-1", "turn-1");
    expect(pausedSessionRecord).toMatchObject({
      state: "paused",
      resumeReason: "auth",
    });
    expect(pausedSessionRecord?.piMessages.at(-1)).toMatchObject({
      role: "toolResult",
      toolName: "loadSkill",
    });
    expect(deliverPrivateMessageMock).toHaveBeenCalledTimes(1);
    expect(pendingAuthRecords).toHaveLength(1);
    expect(pendingAuthRecords.at(-1)).toEqual(
      expect.objectContaining({
        kind: "mcp",
        provider: "demo",
        actorId: "U123",
        sessionId: "turn-1",
      }),
    );
    expect(loadSkillExecutionErrorCount.value).toBe(0);
    expect(incrementStatMock).toHaveBeenCalledWith({
      namespace: "demo",
      metric: "skill_load",
      name: "demo-skill",
    });

    const reply = finalReply(await executeAgentRun(context));

    expect(reply.text).toBe("resumed reply");
    expect(promptCallCount.value).toBe(1);
    expect(continueCallCount.value).toBe(1);
    expect(clientOptions).not.toContainEqual(
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
    expect(agentInitialToolNames[1]).toContain("loadSkill");
    expect(agentInitialToolNames[1]).toContain("searchMcpTools");
    expect(agentInitialToolNames[1]).toContain("callMcpTool");
    expect(agentInitialToolNames[1]).toContain("searchTools");
    expect(agentInitialToolNames[1]).toContain("executeTool");
    expect(agentInitialToolNames[1]).not.toContain("mcp__demo__ping");
    expect(agentInitialSystemPrompts).toEqual([
      "System prompt",
      "System prompt",
    ]);
    expect(resumeTurnContextCounts).toEqual([1]);
    expect(turnContextInputs[0]?.includeSessionContext).toBe(true);
    expect(turnContextInputs).toHaveLength(1);
    expect(searchMcpToolNames).toEqual([[]]);
    expect(callToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ name: "demo" }),
      }),
      "ping",
      { query: "hello" },
    );

    // Generation completing is not delivery: the record stays resumable until
    // the destination boundary commits completion after Slack acceptance.
    const resumedSessionRecord = await getTurnRecord(
      "conversation-1",
      "turn-1",
    );
    expect(resumedSessionRecord).toMatchObject({
      state: "paused",
    });
  });

  it("searches loadSkill-activated MCP tools in the same turn without replay", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue(makeDemoMcpTools());

    const reply = finalReply(
      await executeAgentRun(
        makeAgentRun("help me", {
          conversationId: "conversation-2",
          threadTs: "1712345.0002",
          turnId: "turn-2",
        }),
      ),
    );

    expect(reply.text).toBe("resumed reply");
    expect(promptCallCount.value).toBe(1);
    expect(continueCallCount.value).toBe(0);
    expect(agentInitialToolNames[0]).toContain("loadSkill");
    expect(agentInitialToolNames[0]).toContain("searchMcpTools");
    expect(agentInitialToolNames[0]).toContain("callMcpTool");
    expect(agentInitialToolNames[0]).toContain("searchTools");
    expect(agentInitialToolNames[0]).toContain("executeTool");
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

    // Generation completing is not delivery: the record stays at its running
    // safe boundary until the destination boundary commits completion.
    const sessionRecord = await getTurnRecord("conversation-2", "turn-2");
    expect(sessionRecord).toMatchObject({
      state: "running",
    });
    const events =
      await getConversationEventStore().loadCurrentHistory("conversation-2");
    expect(events.map((event) => event.data)).toContainEqual({
      type: "guardian_action_reviewed",
      turnId: "turn-2",
      toolCallId: expect.any(String),
      toolName: "mcp__demo__ping",
      decision: "allow",
      riskLevel: "low",
      userAuthorization: "high",
    });
  });

  it("keeps MCP search failures outside the action-review boundary", async () => {
    directMcpProviderFailure.value = true;
    listToolsMock.mockReset();
    listToolsMock.mockImplementation(async () => {
      expect(guardianProposals).toHaveLength(0);
      throw new McpProviderError({
        phase: "connect",
        provider: "demo",
      });
    });

    const reply = finalReply(
      await executeAgentRun(
        makeAgentRun("check the demo provider", {
          conversationId: "conversation-provider-failure",
          threadTs: "1712345.0098",
          turnId: "turn-provider-failure",
        }),
      ),
    );

    expect(reply.text).toBe("I couldn't connect to the demo provider.");
    expect(guardianProposals).toEqual([]);
    expect(listToolsMock).toHaveBeenCalledOnce();
    expect(callToolMock).not.toHaveBeenCalled();
    expect(agentAfterToolResults).toHaveLength(1);
  });

  it("wires Guardian denial through the runtime before MCP execution", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue(makeDemoMcpTools());
    guardianDecision.value = "deny";

    await executeAgentRun(
      makeAgentRun("help me", {
        conversationId: "conversation-guardian-deny",
        threadTs: "1712345.0099",
        turnId: "turn-guardian-deny",
      }),
    );

    expect(guardianProposals).toEqual([
      expect.objectContaining({
        input: {
          arguments: { query: "hello" },
          tool_name: "mcp__demo__ping",
        },
        tool: expect.objectContaining({
          name: "mcp__demo__ping",
        }),
      }),
    ]);
    expect(callToolMock).not.toHaveBeenCalled();
    expect(agentAfterToolResults).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          guardianActionRejection: expect.objectContaining({
            decision: "deny",
            priorRejection: expect.objectContaining({
              input: {
                arguments: { query: "hello" },
                tool_name: "mcp__demo__ping",
              },
            }),
          }),
        }),
      }),
    ]);
    const events = await getConversationEventStore().loadCurrentHistory(
      "conversation-guardian-deny",
    );
    expect(events.map((event) => event.data)).toContainEqual({
      type: "guardian_action_reviewed",
      turnId: "turn-guardian-deny",
      toolCallId: expect.any(String),
      toolName: "mcp__demo__ping",
      decision: "deny",
      riskLevel: "high",
      userAuthorization: "low",
    });
  });

  it("escalates unavailable Guardian review to the agent-run boundary", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue(makeDemoMcpTools());
    guardianDecision.value = "unavailable";

    const outcome = await executeAgentRun(
      makeAgentRun("help me", {
        conversationId: "conversation-guardian-unavailable",
        threadTs: "1712345.0100",
        turnId: "turn-guardian-unavailable",
      }),
    );

    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        diagnostics: {
          outcome: "provider_error",
        },
        text: "",
      },
    });
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it("restores MCP providers this actor previously connected before building a follow-up turn prompt", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue(makeDemoMcpTools());
    await recordMcpProviderConnected({
      conversationId: "conversation-restored-provider",
      provider: "demo",
      actorId: "U123",
    });

    await executeAgentRun(
      makeAgentRun("help me", {
        conversationId: "conversation-restored-provider",
        threadTs: "1712345.0090",
        turnId: "turn-restored-provider",
      }),
    );

    expect(turnContextInputs[0]?.activeMcpCatalogs).toEqual([
      { provider: "demo", available_tool_count: 1 },
    ]);
    expect(listToolsMock).toHaveBeenCalledTimes(1);
  });

  it("restores prior MCP providers for a system actor with a delegated credential subject", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue(makeDemoMcpTools());
    // Ownership is the credential subject (U123), not the system scheduler actor.
    await recordMcpProviderConnected({
      conversationId: "conversation-delegated-provider",
      provider: "demo",
      actorId: "U123",
    });

    await executeAgentRun(
      makeAgentRun(
        "run the scheduled task",
        {
          conversationId: "conversation-delegated-provider",
          threadTs: "1712345.0092",
          turnId: "turn-delegated-provider",
        },
        {
          actor: { platform: "system", name: "scheduler" },
          credentialContext: {
            actor: { platform: "system", name: "scheduler" },
            subject: {
              type: "user",
              userId: "U123",
              allowedWhen: "scheduled-task",
              taskId: "scheduled-task-1",
              binding: {
                type: "scheduled-task",
                plugin: "scheduler",
                taskId: "scheduled-task-1",
                signature: "v1=test",
              },
            },
          },
        },
      ),
    );

    expect(turnContextInputs[0]?.activeMcpCatalogs).toEqual([
      { provider: "demo", available_tool_count: 1 },
    ]);
    expect(listToolsMock).toHaveBeenCalledTimes(1);
  });

  it("preserves the execution-limit error when provider restore pauses for auth", async () => {
    const conversationId = "conversation-restore-auth-limit";
    const turnId = "turn-restore-auth-limit";
    const priorMessages = [
      {
        input: {
          tool_name: "mcp__demo__ping",
          arguments: { query: "prior" },
        },
        role: "toolResult",
        toolCallId: "prior-call",
        toolName: "callMcpTool",
        isError: false,
        content: [{ type: "text", text: "pong" }],
        timestamp: 1,
      },
    ] as unknown as PiMessage[];
    await upsertTurnRecord({
      conversationId,
      piMessages: priorMessages,
      resumeReason: "auth",
      sliceId: botConfig.maxSlicesPerTurn,
      state: "paused",
      turnId,
    });

    const error = await executeAgentRun(
      makeAgentRun("current follow-up", {
        conversationId,
        threadTs: "1712345.0090",
        turnId,
      }),
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(TurnSliceLimitExceededError);
    await expect(getTurnRecord(conversationId, turnId)).resolves.toMatchObject({
      errorMessage: expect.stringContaining("execution limit"),
      state: "failed",
    });
  });

  it("adds missing bootstrap context when actor-owned provider restore pauses before prompt", async () => {
    const priorMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "prior question" }],
        timestamp: 1,
      },
      {
        input: {
          tool_name: "mcp__demo__ping",
          arguments: { query: "prior" },
        },
        role: "toolResult",
        toolCallId: "prior-call",
        toolName: "callMcpTool",
        isError: false,
        content: [{ type: "text", text: "pong" }],
        timestamp: 2,
      },
    ] as unknown as PiMessage[];
    await recordMcpProviderConnected({
      conversationId: "conversation-restore-auth",
      provider: "demo",
      actorId: "U123",
    });

    const firstError = await executeAgentRun(
      makeAgentRun(
        "current follow-up",
        {
          conversationId: "conversation-restore-auth",
          threadTs: "1712345.0091",
          turnId: "turn-restore-auth",
        },
        {
          history: priorMessages,
        },
      ),
    ).catch((error) => error);

    expect(firstError.status).toBe("awaiting_auth");

    const pausedSessionRecord = await getTurnRecord(
      "conversation-restore-auth",
      "turn-restore-auth",
    );
    expect(pausedSessionRecord).toMatchObject({
      state: "paused",
      resumeReason: "auth",
    });
    expect(pausedSessionRecord?.turnStartMessageIndex).toBeUndefined();
    expect(pausedSessionRecord?.piMessages).toHaveLength(2);
    expect(pausedSessionRecord?.piMessages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "prior question" }],
    });
    expect(pausedSessionRecord?.piMessages.at(-1)).toMatchObject({
      role: "toolResult",
      toolName: "callMcpTool",
    });
    expect(JSON.stringify(pausedSessionRecord?.piMessages)).not.toContain(
      "current follow-up",
    );

    const reply = finalReply(
      await executeAgentRun(
        makeAgentRun(
          "current follow-up",
          {
            conversationId: "conversation-restore-auth",
            threadTs: "1712345.0091",
            turnId: "turn-restore-auth",
          },
          {
            history: priorMessages,
          },
        ),
      ),
    );

    expect(reply.text).toBe("resumed reply");
    expect(resumeMessages).toHaveLength(0);
    expect(promptSeedMessages.at(-1)?.slice(0, -1)).toEqual(priorMessages);
    expect(JSON.stringify(promptSeedMessages.at(-1)?.at(-1))).toContain(
      "Turn context",
    );
    expect(promptMessages.at(-1)).toMatchObject({
      role: "user",
      content: [
        {
          type: "text",
          text: "<current-instruction>\ncurrent follow-up\n</current-instruction>",
        },
      ],
    });
    expect(resumeTurnContextCounts).toEqual([]);
    expect(turnContextInputs).toHaveLength(1);
    expect(turnContextInputs[0]?.includeSessionContext).toBe(true);
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

    await executeAgentRun(
      makeAgentRun(
        "help me",
        {
          conversationId: "conversation-history",
          threadTs: "1712345.0003",
          turnId: "turn-history",
        },
        {
          instruction: {
            context: "duplicated prior transcript",
          },
          history: priorMessages,
        },
      ),
    );

    expect(promptSeedMessages[0]?.slice(0, -1)).toEqual(priorMessages);
    expect(JSON.stringify(promptSeedMessages[0]?.at(-1))).toContain(
      "Turn context",
    );
    expect(JSON.stringify(promptMessages[0])).not.toContain(
      "duplicated prior transcript",
    );
    expect(JSON.stringify(promptMessages[0])).not.toContain(
      "<thread-background>",
    );
    expect(JSON.stringify(promptMessages[0])).not.toContain("Turn context");
    expect(turnContextInputs.at(-1)?.availableSkills).toEqual([
      expect.objectContaining({ name: "demo-skill" }),
    ]);
    expect(turnContextInputs.at(-1)?.includeSessionContext).toBe(true);
  });

  it("does not duplicate an exact current prompt from a no-checkpoint resume record", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue(makeDemoMcpTools());
    const messageText = `continue & <auth> &lt;literal&gt; "now"`;
    const currentContext = {
      role: "user",
      content: [
        {
          type: "text",
          text: "<runtime-turn-context>\nlegacy bootstrap\n</runtime-turn-context>",
        },
        {
          type: "text",
          text: "<thread-background>trusted context</thread-background>",
        },
      ],
      timestamp: 2,
    } as PiMessage;
    const currentPrompt = {
      role: "user",
      content: [{ type: "text", text: renderCurrentInstruction(messageText) }],
      timestamp: 2,
    } as PiMessage;
    const storedMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "prior question" }],
        timestamp: 1,
      },
      currentContext,
      currentPrompt,
    ] as PiMessage[];
    await upsertTurnRecord({
      conversationId: "conversation-current-resume",
      turnId: "turn-current-resume",
      sliceId: 2,
      state: "paused",
      piMessages: storedMessages,
      resumeReason: "auth",
      errorMessage: "authorization required",
    });

    await executeAgentRun(
      makeAgentRun(messageText, {
        conversationId: "conversation-current-resume",
        threadTs: "1712345.0093",
        turnId: "turn-current-resume",
      }),
    );

    expect(promptSeedMessages.at(-1)?.slice(0, -1)).toEqual([
      storedMessages[0],
    ]);
    expect(JSON.stringify(promptSeedMessages.at(-1)?.at(-1))).toContain(
      "Turn context",
    );
    expect(JSON.stringify(promptMessages.at(-1))).toContain(
      "continue &amp; &lt;auth&gt; &amp;lt;literal&amp;gt; &quot;now&quot;",
    );
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
    await upsertTurnRecord({
      conversationId: "conversation-crash-retry",
      turnId: "turn-crash-retry",
      sliceId: 1,
      state: "running",
      piMessages: storedRunningMessages,
    });

    await executeAgentRun(
      makeAgentRun(
        "continue after crash",
        {
          conversationId: "conversation-crash-retry",
          threadTs: "1712345.00032",
          turnId: "turn-crash-retry",
        },
        {
          history: strippedHistory,
        },
      ),
    );

    expect(promptSeedMessages[0]?.slice(0, -1)).toEqual(strippedHistory);
    expect(JSON.stringify(promptSeedMessages[0]?.at(-1))).toContain(
      "Turn context",
    );
    expect(turnContextInputs.at(-1)?.includeSessionContext).toBe(true);
    expect(JSON.stringify(promptMessages[0])).not.toContain("Turn context");
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

    await executeAgentRun(
      makeAgentRun(
        "help me",
        {
          conversationId: "conversation-history-with-context",
          threadTs: "1712345.00031",
          turnId: "turn-history-with-context",
        },
        {
          history: priorMessages,
        },
      ),
    );

    expect(promptSeedMessages[0]).toEqual(priorMessages);
    expect(turnContextInputs).toHaveLength(0);
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

    const context = makeAgentRun("help me", {
      conversationId: "conversation-4",
      threadTs: "1712345.0004",
      turnId: "turn-4",
    });

    const firstError = await executeAgentRun(context);

    expect(firstError.status).toBe("awaiting_auth");
    expect(deliverPrivateMessageMock).toHaveBeenCalledTimes(1);

    const pausedSessionRecord = await getTurnRecord("conversation-4", "turn-4");
    expect(pausedSessionRecord).toMatchObject({
      state: "paused",
      resumeReason: "auth",
    });

    const reply = finalReply(await executeAgentRun(context));

    expect(reply.text).toBe("resumed reply");

    // Generation completing is not delivery: the record stays resumable until
    // the destination boundary commits completion after Slack acceptance.
    const resumedSessionRecord = await getTurnRecord(
      "conversation-4",
      "turn-4",
    );
    expect(resumedSessionRecord).toMatchObject({
      state: "paused",
    });
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
    // Actor-owned connection drives pre-prompt restore; shared Pi history does not.
    await recordMcpProviderConnected({
      conversationId: "conversation-5",
      provider: "demo",
      actorId: "U123",
    });
    await upsertTurnRecord({
      conversationId: "conversation-5",
      turnId: "turn-5",
      sliceId: 1,
      state: "paused",
      piMessages: expectedResumeMessages,
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

    const firstError = await executeAgentRun(
      makeAgentRun("help me", {
        conversationId: "conversation-5",
        threadTs: "1712345.0005",
        turnId: "turn-5",
      }),
    ).catch((error) => error);

    expect(firstError.status).toBe("awaiting_auth");

    const resumedSessionRecord = await getTurnRecord(
      "conversation-5",
      "turn-5",
    );
    expect(resumedSessionRecord).toMatchObject({
      state: "paused",
      sliceId: 2,
      resumedFromSliceId: 1,
      piMessages: expectedResumeMessages,
      resumeReason: "auth",
    });
  });

  it("still parks for auth when abort leaves an empty completed assistant frame", async () => {
    completeEmptyAssistantOnAbort.value = true;

    const firstError = await executeAgentRun(
      makeAgentRun("help me", {
        conversationId: "conversation-6",
        threadTs: "1712345.0006",
        turnId: "turn-6",
      }),
    ).catch((error) => error);

    expect(firstError.status).toBe("awaiting_auth");

    const pausedSessionRecord = await getTurnRecord("conversation-6", "turn-6");
    expect(pausedSessionRecord).toMatchObject({
      state: "paused",
      resumeReason: "auth",
    });
    expect(pausedSessionRecord?.piMessages.at(-1)).toMatchObject({
      role: "toolResult",
      toolName: "loadSkill",
    });
  });
});
