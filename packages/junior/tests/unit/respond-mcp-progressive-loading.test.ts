import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  agentInitialToolNames,
  deliverPrivateMessageMock,
  listToolsMock,
  loadSkillsByNameMock,
  setToolsCallNames,
} = vi.hoisted(() => ({
  agentInitialToolNames: [] as string[][],
  deliverPrivateMessageMock: vi.fn(),
  listToolsMock: vi.fn(),
  loadSkillsByNameMock: vi.fn(),
  setToolsCallNames: [] as string[][],
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

    setTools(
      tools: Array<{
        name: string;
        execute: (toolCallId: unknown, params: unknown) => Promise<unknown>;
      }>,
    ) {
      this.state.tools = [...tools];
      setToolsCallNames.push(tools.map((tool) => tool.name));
    }

    abort() {}

    async replaceMessages(messages: unknown[]) {
      this.state.messages = [...messages];
    }

    async prompt(message: unknown) {
      this.state.messages.push(message);
      const loadSkillTool = this.state.tools.find(
        (tool) => tool.name === "loadSkill",
      );
      if (!loadSkillTool) {
        throw new Error("loadSkill tool missing");
      }
      await loadSkillTool.execute("tool-call-1", { skill_name: "demo-skill" });
      return {};
    }

    async continue() {
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
    ) {}

    async listTools() {
      return await listToolsMock(this.plugin, this.options);
    }

    async callTool() {
      return {
        content: [{ type: "text", text: "pong" }],
        isError: false,
      };
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
    setToolsCallNames.length = 0;
    deliverPrivateMessageMock.mockReset();
    listToolsMock.mockReset();
    loadSkillsByNameMock.mockReset();

    process.env.JUNIOR_STATE_ADAPTER = "memory";
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";

    deliverPrivateMessageMock.mockResolvedValue({
      channel: "D123",
      threadTs: "1712345.0001",
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
    expect(agentInitialToolNames[0]).not.toContain("mcp__demo__ping");

    const pausedCheckpoint = await getAgentTurnSessionCheckpoint(
      "conversation-1",
      "turn-1",
    );
    expect(pausedCheckpoint).toMatchObject({
      state: "awaiting_resume",
      loadedSkillNames: ["demo-skill"],
      activeMcpProviders: [],
      resumeReason: "auth",
    });
    expect(deliverPrivateMessageMock).toHaveBeenCalledTimes(1);

    const reply = await generateAssistantReply("help me", context);

    expect(reply.text).toBe("resumed reply");
    expect(agentInitialToolNames[1]).toContain("mcp__demo__ping");
    expect(setToolsCallNames).toEqual([]);

    const resumedCheckpoint = await getAgentTurnSessionCheckpoint(
      "conversation-1",
      "turn-1",
    );
    expect(resumedCheckpoint).toMatchObject({
      state: "completed",
      loadedSkillNames: ["demo-skill"],
      activeMcpProviders: ["demo"],
    });
  });
});
