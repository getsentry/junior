import { vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import type { deliverPrivateMessage } from "@/chat/oauth-flow";
import type { Skill, SkillMetadata } from "@/chat/skills";
import type {
  PluginMcpClientOptions,
  PluginMcpListedTool,
  PluginMcpToolCallResult,
} from "@/chat/mcp/client";
import { McpAuthorizationRequiredError } from "@/chat/mcp/client";
import type { PluginDefinition } from "@/chat/plugins/types";
import type { TurnThinkingSelection } from "@/chat/services/turn-thinking-level";
import { createScriptedReplyAgentFactory } from "./respond-agent";
import {
  configureRespondRuntimeEnv,
  restoreRespondRuntimeEnv,
} from "./respond-env";
import {
  createScriptedSandboxExecutorFactory,
  createScriptedSandboxExecutorState,
} from "./respond-sandbox";
import { DEFAULT_TEST_NOW_MS } from "./vitest";

const originalEnv = configureRespondRuntimeEnv();

const hoisted = vi.hoisted(() => {
  const DEMO_SKILL = {
    name: "demo-skill",
    description: "Demo skill",
    skillPath: "/tmp/skills/demo-skill",
    pluginProvider: "demo",
  } as const;

  const demoPlugin: PluginDefinition = {
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

  const state = {
    agentInitialToolNames: [] as string[][],
    callToolMock:
      vi.fn<
        (
          plugin: PluginDefinition,
          name: string,
          args: Record<string, unknown> | undefined,
        ) => Promise<PluginMcpToolCallResult>
      >(),
    clientOptions: [] as Array<Record<string, unknown>>,
    completeEmptyAssistantOnAbort: { value: false },
    continueCallCount: { value: 0 },
    continueStopsOnAbort: { value: false },
    deliverPrivateMessageMock: vi.fn<typeof deliverPrivateMessage>(),
    listToolsMock:
      vi.fn<
        (
          plugin: PluginDefinition,
          options: PluginMcpClientOptions,
        ) => Promise<PluginMcpListedTool[]>
      >(),
    loadSkillExecutionErrorCount: { value: 0 },
    loadSkillsByNameMock:
      vi.fn<
        (skillNames: string[], available: SkillMetadata[]) => Promise<Skill[]>
      >(),
    omitFinalAssistantAfterTool: { value: false },
    promptCallCount: { value: 0 },
    promptMessages: [] as unknown[],
    promptSeedMessages: [] as unknown[][],
    pushPreToolAssistantMessage: { value: false },
    recordToolResultMessage: { value: false },
    resumeMessages: [] as unknown[][],
    resumeTurnContextCounts: [] as number[],
    searchMcpToolNames: [] as string[][],
  };

  return {
    DEMO_SKILL,
    demoPlugin,
    state,
  };
});

const { DEMO_SKILL, demoPlugin, state } = hoisted;

let abortedAgents = new WeakSet<object>();
const sandboxState = createScriptedSandboxExecutorState();
const turnThinkingSelection = {
  thinkingLevel: "medium",
  confidence: 1,
  reason: "test",
} satisfies TurnThinkingSelection;

export const respondMcpProgressiveLoadingHarness = {
  DEMO_SKILL,
  agentInitialToolNames: state.agentInitialToolNames,
  callToolMock: state.callToolMock,
  clientOptions: state.clientOptions,
  completeEmptyAssistantOnAbort: state.completeEmptyAssistantOnAbort,
  continueCallCount: state.continueCallCount,
  continueStopsOnAbort: state.continueStopsOnAbort,
  deliverPrivateMessageMock: state.deliverPrivateMessageMock,
  listToolsMock: state.listToolsMock,
  loadSkillExecutionErrorCount: state.loadSkillExecutionErrorCount,
  loadSkillsByNameMock: state.loadSkillsByNameMock,
  omitFinalAssistantAfterTool: state.omitFinalAssistantAfterTool,
  promptCallCount: state.promptCallCount,
  promptMessages: state.promptMessages,
  promptSeedMessages: state.promptSeedMessages,
  pushPreToolAssistantMessage: state.pushPreToolAssistantMessage,
  recordToolResultMessage: state.recordToolResultMessage,
  resumeMessages: state.resumeMessages,
  resumeTurnContextCounts: state.resumeTurnContextCounts,
  searchMcpToolNames: state.searchMcpToolNames,
};

/** Build the loaded demo skill shape used by progressive MCP tests. */
export function makeDemoLoadedSkill() {
  return {
    ...DEMO_SKILL,
    body: "Skill instructions",
  };
}

/** Build a demo MCP tool with the minimal schema needed by the fake client. */
export function makeDemoMcpTool(name: "ping" | "mutate") {
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
  } satisfies PluginMcpListedTool;
}

/** Build the full demo MCP tool list exposed by the fake plugin provider. */
export function makeDemoMcpTools() {
  return [makeDemoMcpTool("ping"), makeDemoMcpTool("mutate")];
}

/** Build the reply context shared by progressive MCP runtime tests. */
export function makeReplyContext(args: {
  conversationId: string;
  threadTs: string;
  turnId: string;
}) {
  return {
    credentialContext: {
      actor: { type: "user" as const, userId: "U123" },
    },
    destination: {
      platform: "slack" as const,
      teamId: "T123",
      channelId: "C123",
    },
    requester: {
      platform: "slack" as const,
      teamId: "T123",
      userId: "U123",
    },
    correlation: {
      channelId: "C123",
      conversationId: args.conversationId,
      teamId: "T123",
      threadTs: args.threadTs,
      turnId: args.turnId,
    },
  };
}

async function executeAgentTool(
  agent: { state: { tools: unknown[] } },
  name: string,
  params: Record<string, unknown>,
) {
  const tool = agent.state.tools.find(
    (
      candidate,
    ): candidate is {
      execute: (toolCallId: unknown, params: unknown) => Promise<unknown>;
      name: string;
    } =>
      typeof candidate === "object" &&
      candidate !== null &&
      "name" in candidate &&
      candidate.name === name &&
      "execute" in candidate &&
      typeof candidate.execute === "function",
  );
  if (!tool) {
    throw new Error(`${name} tool missing`);
  }
  return await tool.execute(`tool-call-${name}`, params);
}

function hasRuntimeTurnContext(message: unknown): boolean {
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
        (part as { text: string }).text.includes("<runtime-turn-context>"),
    )
  );
}

const scriptedAgentFactory = createScriptedReplyAgentFactory({
  abort(agent) {
    abortedAgents.add(agent);
  },
  async continue(agent) {
    state.continueCallCount.value += 1;
    state.resumeMessages.push([...agent.state.messages]);
    state.resumeTurnContextCounts.push(
      agent.state.messages.filter(hasRuntimeTurnContext).length,
    );

    const lastMessage = agent.state.messages.at(-1) as
      | { role?: unknown }
      | undefined;
    if (lastMessage?.role === "assistant") {
      throw new Error("Cannot continue from message role: assistant");
    }
    await executeAgentTool(agent, "callMcpTool", {
      tool_name: "mcp__demo__ping",
      arguments: { query: "hello" },
    });
    if (abortedAgents.has(agent) && state.continueStopsOnAbort.value) {
      return {};
    }
    agent.state.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "resumed reply" }],
      stopReason: "stop",
    } as PiMessage);
    return {};
  },
  async prompt(agent, message) {
    state.promptCallCount.value += 1;
    abortedAgents.delete(agent);
    state.promptMessages.push(message);
    state.promptSeedMessages.push([...agent.state.messages]);
    agent.state.messages.push(message as PiMessage);

    let loadSkillResult: {
      details?: {
        mcp_provider?: string;
        available_tool_count?: number;
      };
    };
    try {
      loadSkillResult = (await executeAgentTool(agent, "loadSkill", {
        skill_name: DEMO_SKILL.name,
      })) as {
        details?: {
          mcp_provider?: string;
          available_tool_count?: number;
        };
      };
    } catch (error) {
      state.loadSkillExecutionErrorCount.value += 1;
      agent.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "loading demo skill" }],
      } as PiMessage);
      throw error;
    }

    agent.state.messages.push({
      role: "toolResult",
      toolCallId: "tool-call-1",
      toolName: "loadSkill",
      isError: false,
      details: loadSkillResult.details,
      content: [{ type: "text", text: "loaded" }],
    } as PiMessage);
    if (abortedAgents.has(agent)) {
      agent.state.messages.push({
        role: "assistant",
        content: [
          {
            type: "text",
            text: state.completeEmptyAssistantOnAbort.value
              ? ""
              : "loading demo skill",
          },
        ],
        ...(state.completeEmptyAssistantOnAbort.value
          ? { stopReason: "stop" }
          : {}),
      } as PiMessage);
      return {};
    }

    if (loadSkillResult.details?.mcp_provider) {
      const searchResult = (await executeAgentTool(agent, "searchMcpTools", {
        provider: loadSkillResult.details.mcp_provider,
        query: "ping query",
      })) as {
        details?: { tools?: Array<{ tool_name: string }> };
      };
      state.searchMcpToolNames.push(
        (searchResult.details?.tools ?? []).map((tool) => tool.tool_name),
      );
    }
    if (state.pushPreToolAssistantMessage.value) {
      agent.state.messages.push({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Let me search for related articles and compare perspectives.",
          },
        ],
      } as PiMessage);
    }

    await executeAgentTool(agent, "callMcpTool", {
      tool_name: "mcp__demo__ping",
      arguments: { query: "hello" },
    });
    if (state.recordToolResultMessage.value) {
      agent.state.messages.push({
        role: "toolResult",
        toolName: "callMcpTool",
        isError: false,
        content: [{ type: "text", text: "pong" }],
      } as PiMessage);
    }
    if (state.omitFinalAssistantAfterTool.value) {
      return {};
    }
    agent.state.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "resumed reply" }],
      stopReason: "stop",
    } as PiMessage);
    return {};
  },
});

const agentFactory: typeof scriptedAgentFactory = (options) => {
  state.agentInitialToolNames.push(
    options.initialState.tools.map((tool) =>
      typeof tool === "object" &&
      tool !== null &&
      "name" in tool &&
      typeof (tool as { name?: unknown }).name === "string"
        ? (tool as { name: string }).name
        : "",
    ),
  );
  return scriptedAgentFactory(options);
};

function mcpClientFactory(
  plugin: PluginDefinition,
  options: PluginMcpClientOptions,
) {
  state.clientOptions.push({ ...options });
  return {
    async listTools() {
      return await state.listToolsMock(plugin, options);
    },
    async callTool(name: string, args: Record<string, unknown> | undefined) {
      return await state.callToolMock(plugin, name, args);
    },
    async close() {
      return undefined;
    },
  };
}

const { createMcpAuthOrchestration: createMcpAuthOrchestrationImpl } =
  await import("@/chat/services/mcp-auth-orchestration");
const { getConfigDefaults: getConfigDefaultsImpl } =
  await import("@/chat/configuration/defaults");
const {
  deleteMcpAuthSession: deleteMcpAuthSessionImpl,
  getMcpAuthSession: getMcpAuthSessionImpl,
  patchMcpAuthSession: patchMcpAuthSessionImpl,
  putMcpAuthSession: putMcpAuthSessionImpl,
} = await import("@/chat/mcp/auth-store");
const {
  findSkillByName: findSkillByNameImpl,
  parseSkillInvocation: parseSkillInvocationImpl,
} = await import("@/chat/skills");
const { recordAuthorizationRequested: recordAuthorizationRequestedImpl } =
  await import("@/chat/state/session-log");
const { generateAssistantReply: generateAssistantReplyImpl } =
  await import("@/chat/respond");
const { isRetryableTurnError: isRetryableTurnErrorImpl } =
  await import("@/chat/runtime/turn");
const { disconnectStateAdapter: disconnectStateAdapterImpl } =
  await import("@/chat/state/adapter");
const {
  getAgentTurnSessionRecord: getAgentTurnSessionRecordImpl,
  upsertAgentTurnSessionRecord: upsertAgentTurnSessionRecordImpl,
} = await import("@/chat/state/turn-session");

const mcpAuthServices = {
  createMcpOAuthClientProvider: async (input) => {
    const authSessionId = `${input.provider}-auth-session`;
    await putMcpAuthSessionImpl({
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
      createdAtMs: DEFAULT_TEST_NOW_MS,
      updatedAtMs: DEFAULT_TEST_NOW_MS,
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
        await patchMcpAuthSessionImpl(authSessionId, {
          authorizationUrl: authorizationUrl.toString(),
        });
      },
      saveCodeVerifier: async () => undefined,
      codeVerifier: async () => "code-verifier",
    };
  },
  deleteMcpAuthSession: deleteMcpAuthSessionImpl,
  deliverPrivateMessage: state.deliverPrivateMessageMock,
  getMcpAuthSession: getMcpAuthSessionImpl,
  patchMcpAuthSession: patchMcpAuthSessionImpl,
  recordAuthorizationRequested: recordAuthorizationRequestedImpl,
} satisfies NonNullable<Parameters<typeof createMcpAuthOrchestrationImpl>[2]>;

type ReplyContext = NonNullable<
  Parameters<typeof generateAssistantReplyImpl>[1]
>;

const respondRuntimeServices = {
  createMcpAuthOrchestration: (deps, abortAgent) =>
    createMcpAuthOrchestrationImpl(deps, abortAgent, mcpAuthServices),
  discoverSkills: async () => [DEMO_SKILL],
  findSkillByName: findSkillByNameImpl,
  getConfigDefaults: getConfigDefaultsImpl,
  getPluginMcpProviders: () => [demoPlugin],
  getPluginProviders: () => [demoPlugin],
  loadSkillsByName: state.loadSkillsByNameMock,
  parseSkillInvocation: parseSkillInvocationImpl,
} satisfies NonNullable<
  NonNullable<ReplyContext["harness"]>["runtimeServices"]
>;

/** Run respond through the explicit MCP/agent/sandbox ports used by this fixture. */
export async function generateAssistantReply(
  message: string,
  context: Parameters<typeof generateAssistantReplyImpl>[1] = {},
) {
  const { harness, ...restContext } = context;
  return await generateAssistantReplyImpl(message, {
    recordPendingAuth: async () => undefined,
    ...restContext,
    harness: {
      agentFactory,
      mcpClientFactory,
      runtimeServices: respondRuntimeServices,
      sandboxExecutorFactory:
        createScriptedSandboxExecutorFactory(sandboxState),
      turnThinkingSelection,
      ...harness,
    },
  });
}

export const getAgentTurnSessionRecord = getAgentTurnSessionRecordImpl;
export const isRetryableTurnError = isRetryableTurnErrorImpl;
export const upsertAgentTurnSessionRecord = upsertAgentTurnSessionRecordImpl;
export { McpAuthorizationRequiredError };

/** Reset MCP/respond runtime state before each progressive-loading test. */
export async function setupRespondMcpProgressiveLoadingTest(): Promise<void> {
  state.agentInitialToolNames.length = 0;
  state.callToolMock.mockReset();
  state.clientOptions.length = 0;
  state.completeEmptyAssistantOnAbort.value = false;
  state.continueCallCount.value = 0;
  state.continueStopsOnAbort.value = false;
  state.deliverPrivateMessageMock.mockReset();
  state.listToolsMock.mockReset();
  state.searchMcpToolNames.length = 0;
  state.loadSkillExecutionErrorCount.value = 0;
  state.loadSkillsByNameMock.mockReset();
  state.omitFinalAssistantAfterTool.value = false;
  state.promptCallCount.value = 0;
  state.promptMessages.length = 0;
  state.promptSeedMessages.length = 0;
  state.pushPreToolAssistantMessage.value = false;
  state.recordToolResultMessage.value = false;
  state.resumeMessages.length = 0;
  state.resumeTurnContextCounts.length = 0;
  abortedAgents = new WeakSet<object>();

  process.env.JUNIOR_BASE_URL = "https://junior.example.com";

  state.deliverPrivateMessageMock.mockResolvedValue("in_context");
  state.callToolMock.mockResolvedValue({
    content: [{ type: "text", text: "pong" }],
    isError: false,
  });
  state.loadSkillsByNameMock.mockResolvedValue([makeDemoLoadedSkill()]);
  state.listToolsMock
    .mockImplementationOnce(async (plugin, options) => {
      await options.authProvider?.redirectToAuthorization?.(
        new URL(`https://auth.example.com/${plugin.manifest.name}`),
      );
      throw new McpAuthorizationRequiredError(
        plugin.manifest.name,
        "Auth required",
      );
    })
    .mockResolvedValue(makeDemoMcpTools());

  await disconnectStateAdapterImpl();
}

/** Restore memory state and process globals after progressive-loading tests. */
export async function cleanupRespondMcpProgressiveLoadingTest(): Promise<void> {
  await disconnectStateAdapterImpl();
  delete process.env.JUNIOR_BASE_URL;
  vi.restoreAllMocks();
}

/** Restore import-time env values captured for the progressive MCP respond fixture. */
export function restoreRespondMcpProgressiveLoadingEnv(): void {
  restoreRespondRuntimeEnv(originalEnv);
}

export type { PiMessage };
