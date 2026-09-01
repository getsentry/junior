import {
  createLocalSource,
  createSlackSource,
  createWebSource,
  definePromptContext,
  definePluginTool,
  defineJuniorPlugin,
  pluginToolOutputSchema,
  RESOURCE_EVENT_SUMMARY_MAX_LENGTH,
  RESOURCE_EVENT_TEXT_MAX_LENGTH,
  type ResourceEvent,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { logWarnMock, resolveViewerUserMock } = vi.hoisted(() => ({
  logWarnMock: vi.fn(),
  resolveViewerUserMock: vi.fn(),
}));

vi.mock("@/chat/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/logging")>();
  return {
    ...actual,
    logWarn: logWarnMock,
  };
});
vi.mock("@/chat/plugins/viewer", () => ({
  resolveViewerUser: resolveViewerUserMock,
}));
import {
  applyPluginFormatMarkdown,
  createPluginHookRunner,
  getPluginApiRoutes,
  getPluginSystemPromptContributions,
  getPluginUserPromptContributions,
  getPluginOperationalReports,
  getPluginProfileReports,
  getPluginRoutes,
  getPluginSlackConversationLink,
  getPluginTools,
  setPlugins,
} from "@/chat/plugins/agent-hooks";
import { createTools } from "@/chat/tools";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import type {
  SandboxCommandInput,
  SandboxSession,
} from "@/chat/sandbox/workspace";

const demoToolResultSchema = pluginToolOutputSchema.extend({
  message: z.string(),
});

function demoPluginTool(
  description = "Demo tool",
  approvalMode?: "auto" | "review" | "approve",
) {
  return definePluginTool({
    approvalMode,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    describeProposal: () => `${description} proposal`,
    description,
    inputSchema: z.object({}),
    outputSchema: demoToolResultSchema,
    execute: () => ({ message: "done" }),
  });
}

const TEST_ACTOR = {
  platform: "slack",
  teamId: "T123",
  userId: "U123",
} as const;

const LOCAL_DESTINATION = {
  platform: "local",
  conversationId: "local:test:agent-hooks",
} as const;
const LOCAL_SOURCE = createLocalSource(LOCAL_DESTINATION.conversationId);
const TEST_EGRESS = {
  async fetch() {
    return new Response("ok");
  },
};

const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "DDM",
} as const;
const SLACK_SOURCE = createSlackSource({
  teamId: SLACK_DESTINATION.teamId,
  channelId: SLACK_DESTINATION.channelId,
  visibility: "private",
});

class PrototypeTool {
  annotations = {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  };
  description = "Prototype tool";
  inputSchema = z.toJSONSchema(z.object({}));
  outputSchema = z.toJSONSchema(demoToolResultSchema);

  execute() {
    return { message: "done" };
  }
}

function slackSource(channelId: string) {
  return createSlackSource({
    teamId: "T123",
    channelId,

    visibility: "private",
  });
}

function fakeSandbox(
  writes: Array<{ content: string | Uint8Array; path: string }>,
): SandboxSession {
  return {
    sandboxId: "sandbox-agent-hooks",
    sessionId: "session-agent-hooks",
    fs: {
      async readFile() {
        return "";
      },
      async writeFile() {},
      async readdir() {
        return [];
      },
      async stat() {
        return { isDirectory: () => false };
      },
    },
    async extendTimeout() {},
    async mkDir() {},
    async readFileToBuffer() {
      return null;
    },
    async runCommand() {
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    },
    async snapshot() {
      return { snapshotId: "snapshot-agent-hooks" };
    },
    async stop() {},
    async update() {},
    async writeFiles(files) {
      writes.push(
        ...files.map((file) => ({
          path: file.path,
          content: file.content,
        })),
      );
    },
  };
}

describe("agent plugin hooks", () => {
  beforeEach(() => {
    logWarnMock.mockReset();
    resolveViewerUserMock.mockReset();
  });

  it("accepts Slack source visibility from the runtime boundary", () => {
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "C123",
        visibility: "public",
        threadTs: "1718800000.000000",
      }).visibility,
    ).toBe("public");
    // Without a signal, C-prefixed channels fail closed to private.
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "C123",
        threadTs: "1718800000.000000",

        visibility: "private",
      }).visibility,
    ).toBe("private");
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "D123",
        threadTs: "1718800000.000000",

        visibility: "private",
      }).visibility,
    ).toBe("private");
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "G123",
        threadTs: "1718800000.000000",

        visibility: "private",
      }).visibility,
    ).toBe("private");
  });

  it("applies formatMarkdown transforms and fails open on plugin errors", () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "a-demo",
          displayName: "A Demo",
          description: "A demo",
        },
        hooks: {
          formatMarkdown({ text }) {
            return text.replaceAll("alpha", "beta");
          },
        },
      }),
      defineJuniorPlugin({
        manifest: {
          name: "z-demo",
          displayName: "Z Demo",
          description: "Z demo",
        },
        hooks: {
          formatMarkdown() {
            throw new Error("boom");
          },
        },
      }),
    ]);
    try {
      expect(applyPluginFormatMarkdown("alpha one")).toBe("beta one");
      expect(logWarnMock).toHaveBeenCalledWith(
        "plugin.format_markdown.hook.failed",
        expect.objectContaining({ "app.plugin.name": "z-demo" }),
      );
    } finally {
      setPlugins(previous);
    }
  });

  it("collects system prompt contributions from configured plugins", async () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "z-demo",
          displayName: "Z Demo",
          description: "Z demo",
        },
        hooks: {
          systemPrompt(ctx) {
            expect(ctx.platform).toBe("local");
            expect(ctx.db).toEqual(expect.any(Object));
            return [{ text: "Z contribution" }];
          },
        },
      }),
      defineJuniorPlugin({
        manifest: {
          name: "a-demo",
          displayName: "A Demo",
          description: "A demo",
        },
        hooks: {
          systemPrompt() {
            return [{ text: "A contribution" }];
          },
        },
      }),
    ]);
    try {
      await expect(
        getPluginSystemPromptContributions("local"),
      ).resolves.toEqual([
        { id: "systemPrompt:0", pluginName: "a-demo", text: "A contribution" },
        { id: "systemPrompt:0", pluginName: "z-demo", text: "Z contribution" },
      ]);
    } finally {
      setPlugins(previous);
    }
  });

  it("omits malformed system prompt messages", async () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          systemPrompt() {
            return [{ text: "" }] as any;
          },
        },
      }),
    ]);
    try {
      await expect(
        getPluginSystemPromptContributions("local"),
      ).resolves.toEqual([]);
    } finally {
      setPlugins(previous);
    }
  });

  it("collects user prompt messages from configured plugins", async () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          async userPrompt(ctx) {
            expect(ctx.actor).toBeUndefined();
            expect(ctx.source).toEqual(LOCAL_SOURCE);
            expect(ctx.text).toBe("remember this");
            expect(ctx).toHaveProperty("embedder");
            expect(ctx).toHaveProperty("model");
            return [{ text: "remembered context" }];
          },
        },
      }),
    ]);
    try {
      await expect(
        getPluginUserPromptContributions({
          context: {
            conversationId: "conversation-1",
            source: LOCAL_SOURCE,
            destination: LOCAL_DESTINATION,
            userText: "remember this",
          },
        }),
      ).resolves.toEqual([
        {
          id: "userPrompt:0",
          pluginName: "agent-demo",
          text: "remembered context",
        },
      ]);
    } finally {
      setPlugins(previous);
    }
  });

  it("keeps web actors and Slack destinations for dashboard continues", async () => {
    const webActor = {
      platform: "web" as const,
      userId: "dashboard:alice",
      email: "alice@example.com",
    };
    const slackDestination = {
      platform: "slack" as const,
      teamId: "T123",
      channelId: "C123",
    };
    const webSource = createWebSource("slack:C123:1712345.0001", "public");
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          async userPrompt(ctx) {
            expect(ctx.actor).toEqual(webActor);
            expect(ctx.destination).toEqual(slackDestination);
            expect(ctx.source).toEqual(webSource);
            return [{ text: "web continue context" }];
          },
        },
      }),
    ]);
    try {
      await expect(
        getPluginUserPromptContributions({
          context: {
            conversationId: "slack:C123:1712345.0001",
            actor: webActor,
            destination: slackDestination,
            source: webSource,
            userText: "continue from the dashboard",
          },
        }),
      ).resolves.toEqual([
        {
          id: "userPrompt:0",
          pluginName: "agent-demo",
          text: "web continue context",
        },
      ]);
    } finally {
      setPlugins(previous);
    }
  });

  it("renders and retains typed user prompt context", async () => {
    const recall = definePromptContext({
      kind: "recall",
      version: 1,
      schema: z.object({
        memories: z.array(z.object({ id: z.string(), content: z.string() })),
      }),
      renderPrompt: ({ memories }) =>
        memories.map((memory) => memory.content).join("\n"),
    });
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "memory",
          displayName: "Memory",
          description: "Memory",
        },
        hooks: {
          userPrompt() {
            return [
              recall({
                memories: [{ id: "memory-1", content: "Use pnpm." }],
              }),
            ];
          },
        },
      }),
    ]);
    try {
      await expect(
        getPluginUserPromptContributions({
          context: {
            conversationId: "conversation-1",
            source: LOCAL_SOURCE,
            destination: LOCAL_DESTINATION,
            userText: "hello",
          },
        }),
      ).resolves.toEqual([
        {
          id: "userPrompt:0",
          pluginName: "memory",
          text: "Use pnpm.",
          context: {
            content: {
              memories: [{ id: "memory-1", content: "Use pnpm." }],
            },
            kind: "recall",
            loadedAtMs: expect.any(Number),
            pluginName: "memory",
            version: 1,
          },
        },
      ]);
    } finally {
      setPlugins(previous);
    }
  });

  it("omits invalid user prompt messages", async () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          userPrompt() {
            return [{ text: "" }] as any;
          },
        },
      }),
    ]);
    try {
      await expect(
        getPluginUserPromptContributions({
          context: {
            conversationId: "conversation-1",
            source: LOCAL_SOURCE,
            destination: LOCAL_DESTINATION,
            userText: "hello",
          },
        }),
      ).resolves.toEqual([]);
    } finally {
      setPlugins(previous);
    }
  });

  it("omits empty user prompt message arrays", async () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          userPrompt() {
            return [];
          },
        },
      }),
    ]);
    try {
      await expect(
        getPluginUserPromptContributions({
          context: {
            conversationId: "conversation-1",
            source: LOCAL_SOURCE,
            destination: LOCAL_DESTINATION,
            userText: "hello",
          },
        }),
      ).resolves.toEqual([]);
    } finally {
      setPlugins(previous);
    }
  });

  it("omits plugin contributions that exceed the aggregate prompt budget", async () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          userPrompt() {
            return [{ text: "x".repeat(8_000) }, { text: "y".repeat(8_000) }];
          },
        },
      }),
      defineJuniorPlugin({
        manifest: {
          name: "overflow-demo",
          displayName: "Overflow Demo",
          description: "Overflow demo",
        },
        hooks: {
          userPrompt() {
            return [{ text: "z" }];
          },
        },
      }),
    ]);
    try {
      await expect(
        getPluginUserPromptContributions({
          context: {
            conversationId: "conversation-1",
            source: LOCAL_SOURCE,
            destination: LOCAL_DESTINATION,
            userText: "hello",
          },
        }),
      ).resolves.toEqual([
        {
          id: "userPrompt:0",
          pluginName: "agent-demo",
          text: "x".repeat(8_000),
        },
        {
          id: "userPrompt:1",
          pluginName: "agent-demo",
          text: "y".repeat(8_000),
        },
      ]);
    } finally {
      setPlugins(previous);
    }
  });

  it("collects turn-scoped tools from configured plugins", async () => {
    const identity = {
      id: "identity-1",
      provider: "slack",
      providerSubjectId: TEST_ACTOR.userId,
      providerTenantId: TEST_ACTOR.teamId,
    };
    const user = {
      email: "person@example.com",
      id: "user-1",
      identities: [identity],
    };
    let resolveActor:
      | ToolRegistrationHookContext["users"]["resolveActor"]
      | undefined;
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        resourceEvents: {
          resourceTypes: [
            { type: "demo", supportedEvents: ["demo.completed"] },
          ],
        },
        hooks: {
          tools(ctx) {
            expect(ctx.actor).toEqual(TEST_ACTOR);
            expect(ctx.resourceEvents.canSubscribe).toBe(true);
            resolveActor = ctx.users.resolveActor;
            return {
              demoTool: demoPluginTool("Demo tool", "review"),
            };
          },
        },
      }),
    ]);
    try {
      const tools = getPluginTools({
        conversationId: "slack:DDM:1712345.0001",
        destination: SLACK_DESTINATION,
        actor: TEST_ACTOR,
        egress: TEST_EGRESS,
        resolveActorIdentity: async () => ({ identity, user }),
        source: SLACK_SOURCE,
        workspace: {} as any,
      });

      await expect(resolveActor?.()).resolves.toEqual({ identity, user });
      expect(tools).toHaveProperty("agentDemo_demoTool");
      expect(tools.demoTool).toBeUndefined();
      expect(tools.agentDemo_demoTool?.identity).toEqual({
        id: "agent-demo.demoTool",
        name: "demoTool",
        plugin: "agent-demo",
      });
      expect(tools.agentDemo_demoTool?.source).toEqual({
        id: "agent-demo",
        description: "Agent demo",
      });
      expect(tools.agentDemo_demoTool?.approvalMode).toBe("review");
      expect(tools.agentDemo_demoTool?.describeProposal?.({})).toBe(
        "Demo tool proposal",
      );
    } finally {
      setPlugins(previous);
    }
  });

  it("allows resource subscription hints for conversations", () => {
    const webActor = {
      platform: "web" as const,
      userId: "dashboard:alice",
      email: "alice@example.com",
    };
    const webSource = createWebSource("local:web:dashboard-1", "public");
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        resourceEvents: {
          resourceTypes: [
            { type: "demo", supportedEvents: ["demo.completed"] },
          ],
        },
        hooks: {
          tools(ctx) {
            expect(ctx.resourceEvents.canSubscribe).toBe(true);
            return {
              demoTool: demoPluginTool("Demo tool", "review"),
            };
          },
        },
      }),
    ]);
    try {
      const tools = getPluginTools({
        conversationId: "local:web:dashboard-1",
        destination: LOCAL_DESTINATION,
        actor: webActor,
        egress: TEST_EGRESS,
        source: webSource,
        workspace: {} as any,
      });

      expect(tools).toHaveProperty("agentDemo_demoTool");
    } finally {
      setPlugins(previous);
    }
  });

  it("warns when a plugin tool omits behavioral annotations", () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          tools() {
            return {
              demoTool: definePluginTool({
                description: "Demo tool",
                inputSchema: z.object({}),
                outputSchema: demoToolResultSchema,
                execute: () => ({ message: "done" }),
              }),
            };
          },
        },
      }),
    ]);
    try {
      getPluginTools({
        conversationId: "slack:DDM:1712345.0001",
        destination: SLACK_DESTINATION,
        actor: TEST_ACTOR,
        egress: TEST_EGRESS,
        source: SLACK_SOURCE,
        workspace: {} as any,
      });

      expect(logWarnMock).toHaveBeenCalledWith(
        "plugin.tool_annotations.missing",
        {
          "app.plugin.name": "agent-demo",
          "gen_ai.tool.name": "demoTool",
          "app.tool.missing_annotations":
            "destructiveHint,idempotentHint,openWorldHint,readOnlyHint",
        },
      );
    } finally {
      setPlugins(previous);
    }
  });

  it("preserves plugin tool instances while adding internal identity", () => {
    const prototypeTool = new PrototypeTool();
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          tools(ctx) {
            expect(ctx.resourceEvents.canSubscribe).toBe(false);
            return {
              prototypeTool,
            };
          },
        },
      }),
    ]);
    try {
      const tools = getPluginTools({
        conversationId: LOCAL_DESTINATION.conversationId,
        destination: LOCAL_DESTINATION,
        egress: TEST_EGRESS,
        source: LOCAL_SOURCE,
        workspace: {} as any,
      });

      expect(tools.agentDemo_prototypeTool).toBe(prototypeTool);
      expect(tools.prototypeTool).toBeUndefined();
      expect(tools.agentDemo_prototypeTool?.approvalMode).toBe("auto");
      expect(tools.agentDemo_prototypeTool?.identity).toEqual({
        id: "agent-demo.prototypeTool",
        name: "prototypeTool",
        plugin: "agent-demo",
      });
      expect(tools.agentDemo_prototypeTool?.source).toEqual({
        id: "agent-demo",
        description: "Agent demo",
      });
      const prototypeResult = tools.agentDemo_prototypeTool?.execute?.(
        {},
        {},
      ) as ReturnType<PrototypeTool["execute"]> | undefined;
      expect(prototypeResult).toEqual({
        message: "done",
      });
    } finally {
      setPlugins(previous);
    }
  });

  it("normalizes hyphen edge cases in plugin tool namespaces", () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent--demo-",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          tools() {
            return {
              demoTool: demoPluginTool(),
            };
          },
        },
      }),
    ]);
    try {
      const tools = getPluginTools({
        conversationId: LOCAL_DESTINATION.conversationId,
        destination: LOCAL_DESTINATION,
        egress: TEST_EGRESS,
        source: LOCAL_SOURCE,
        workspace: {} as any,
      });

      expect(tools.agentDemo_demoTool).toBeDefined();
      expect(tools["agent-Demo-_demoTool"]).toBeUndefined();
    } finally {
      setPlugins(previous);
    }
  });

  it("rejects plugin tools with invalid names", () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          tools() {
            return {
              "not-valid": demoPluginTool(),
            };
          },
        },
      }),
    ]);
    try {
      expect(() =>
        getPluginTools({
          conversationId: LOCAL_DESTINATION.conversationId,
          destination: LOCAL_DESTINATION,
          egress: TEST_EGRESS,
          source: LOCAL_SOURCE,
          workspace: {} as any,
        }),
      ).toThrow("must be a camelCase identifier");
    } finally {
      setPlugins(previous);
    }
  });

  it("prefixes plugin tools so local names cannot conflict with core tools", () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          tools() {
            return {
              loadSkill: demoPluginTool(),
            };
          },
        },
      }),
    ]);
    try {
      const tools = createTools(
        [],
        {},
        {
          conversationId: LOCAL_DESTINATION.conversationId,
          destination: LOCAL_DESTINATION,
          egress: TEST_EGRESS,
          source: LOCAL_SOURCE,
          workspace: {} as any,
        },
      );
      expect(tools.loadSkill).toBeDefined();
      expect(tools.agentDemo_loadSkill).toBeDefined();
    } finally {
      setPlugins(previous);
    }
  });

  it("activates MCP providers for wrapper tool calls", async () => {
    let captured: ToolRegistrationHookContext | undefined;
    const activeProviders = new Set<string>();
    let authorizationPending = false;
    const activateProvider = vi.fn(async (provider: string) => {
      if (!authorizationPending) {
        activeProviders.add(provider);
      }
      return !authorizationPending;
    });
    const callWrappedTool = vi.fn(async () => ({
      status: "success" as const,
      content: [{ type: "text" as const, text: "created" }],
      structuredContent: { identifier: "ENG-123" },
    }));
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "linear",
          displayName: "Linear",
          description: "Linear",
          mcp: {
            transport: "http",
            url: "https://mcp.linear.example.test/mcp",
            wrappedTools: ["create_issue"],
          },
        },
        hooks: {
          tools(ctx) {
            captured = ctx;
            return {};
          },
        },
      }),
    ]);
    try {
      getPluginTools({
        conversationId: LOCAL_DESTINATION.conversationId,
        destination: LOCAL_DESTINATION,
        egress: TEST_EGRESS,
        mcpToolManager: {
          activateProvider,
          callWrappedTool,
          getActiveProviders: () => [...activeProviders],
        } as never,
        source: LOCAL_SOURCE,
        workspace: {} as any,
      });

      await expect(
        captured?.mcp?.callTool({
          name: "create_issue",
          arguments: { title: "Wrapped issue" },
          toolCallId: "call-1",
        }),
      ).resolves.toMatchObject({
        status: "success",
        structuredContent: { identifier: "ENG-123" },
      });
      expect(activateProvider).toHaveBeenCalledWith("linear");
      expect(callWrappedTool).toHaveBeenCalledWith(
        "linear",
        "create_issue",
        { title: "Wrapped issue" },
        { toolCallId: "call-1" },
      );
      authorizationPending = true;
      activeProviders.clear();
      callWrappedTool.mockClear();
      await expect(
        captured?.mcp?.callTool({ name: "create_issue" }),
      ).resolves.toEqual({ status: "authorization_pending" });
      expect(callWrappedTool).not.toHaveBeenCalled();
    } finally {
      setPlugins(previous);
    }
  });

  it("validates plugin task registration names", () => {
    const previous = setPlugins([]);
    try {
      expect(() =>
        setPlugins([
          defineJuniorPlugin({
            manifest: {
              name: "agent-demo",
              displayName: "Agent Demo",
              description: "Agent demo",
            },
            tasks: {
              processSession: {
                run() {},
              },
            },
          }),
        ]),
      ).not.toThrow();

      expect(() =>
        setPlugins([
          defineJuniorPlugin({
            manifest: {
              name: "agent-demo",
              displayName: "Agent Demo",
              description: "Agent demo",
            },
            tasks: {
              "bad-task": {
                run() {},
              },
            },
          }),
        ]),
      ).toThrow('Plugin task "bad-task"');

      expect(() =>
        setPlugins([
          defineJuniorPlugin({
            manifest: {
              name: "agent-demo",
              displayName: "Agent Demo",
              description: "Agent demo",
            },
            tasks: {
              processSession: {} as any,
            },
          }),
        ]),
      ).toThrow('Plugin task "processSession"');
    } finally {
      setPlugins(previous);
    }
  });

  it("collects route handlers from configured plugins", async () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        resourceEvents: {
          resourceTypes: [{ type: "demo", supportedEvents: ["demo.created"] }],
          normalizeIdentifier: (identifier) => identifier.toLowerCase(),
        },
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          routes(ctx) {
            return [
              {
                path: "/demo",
                async handler() {
                  await ctx.resourceEvents.publish({
                    eventKey: "demo:event",
                    eventType: "demo.created",
                    occurredAtMs: 1,
                    identifier: "Resource:1",
                    trustedSummary: "s".repeat(
                      RESOURCE_EVENT_SUMMARY_MAX_LENGTH + 1,
                    ),
                    untrustedText: "u".repeat(
                      RESOURCE_EVENT_TEXT_MAX_LENGTH + 1,
                    ),
                  });
                  return new Response("demo");
                },
              },
            ];
          },
        },
      }),
    ]);
    try {
      const publish = vi.fn(async (_event: ResourceEvent) => {});
      const routes = getPluginRoutes({ resourceEvents: { publish } });

      expect(routes).toHaveLength(1);
      expect(routes[0]?.pluginName).toBe("agent-demo");
      expect(routes[0]?.path).toBe("/demo");
      const response = await routes[0]!.handler(
        new Request("http://localhost/demo"),
      );
      await expect(response.text()).resolves.toBe("demo");
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: "demo:event",
          identifier: "resource:1",
          namespace: "agent-demo",
        }),
      );
      const published = publish.mock.calls[0]?.[0];
      expect(published?.trustedSummary).toHaveLength(
        RESOURCE_EVENT_SUMMARY_MAX_LENGTH,
      );
      expect(published?.untrustedText).toHaveLength(
        RESOURCE_EVENT_TEXT_MAX_LENGTH,
      );
    } finally {
      setPlugins(previous);
    }
  });

  it("rejects plugin-supplied resource event namespaces", async () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          routes(ctx) {
            return [
              {
                path: "/demo",
                async handler() {
                  await ctx.resourceEvents.publish({
                    eventKey: "other:event",
                    eventType: "demo.created",
                    occurredAtMs: 1,
                    identifier: "resource:1",
                    namespace: "other",
                    trustedSummary: "Demo created",
                  } as any);
                  return new Response("demo");
                },
              },
            ];
          },
        },
      }),
    ]);
    try {
      const publish = vi.fn(async () => {});
      const [route] = getPluginRoutes({ resourceEvents: { publish } });

      await expect(
        route!.handler(new Request("http://localhost/demo")),
      ).rejects.toThrow(/Unrecognized key.*namespace/s);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      setPlugins(previous);
    }
  });

  it.each([
    {
      label: "without a registration",
      resourceEvents: undefined,
      error: "without an active registration",
    },
    {
      label: "while its registration is disabled",
      resourceEvents: {
        resourceTypes: [{ type: "demo", supportedEvents: ["demo.created"] }],
        isEnabled: () => false,
      },
      error: "without an active registration",
    },
    {
      label: "when the event type is undeclared",
      resourceEvents: {
        resourceTypes: [{ type: "demo", supportedEvents: ["demo.created"] }],
      },
      error: 'did not register resource event "demo.deleted"',
    },
  ])(
    "rejects resource event publication $label",
    async ({ resourceEvents, error }) => {
      const previous = setPlugins([
        defineJuniorPlugin({
          ...(resourceEvents ? { resourceEvents } : undefined),
          manifest: {
            name: "agent-demo",
            displayName: "Agent Demo",
            description: "Agent demo",
          },
          hooks: {
            routes(ctx) {
              return [
                {
                  path: "/demo",
                  async handler() {
                    await ctx.resourceEvents.publish({
                      eventKey: "demo:event",
                      eventType: "demo.deleted",
                      occurredAtMs: 1,
                      identifier: "resource:1",
                      trustedSummary: "Demo deleted",
                    });
                    return new Response("demo");
                  },
                },
              ];
            },
          },
        }),
      ]);
      try {
        const publish = vi.fn(async () => {});
        const [route] = getPluginRoutes({ resourceEvents: { publish } });

        await expect(
          route!.handler(new Request("http://localhost/demo")),
        ).rejects.toThrow(error);
        expect(publish).not.toHaveBeenCalled();
      } finally {
        setPlugins(previous);
      }
    },
  );

  it("rejects invalid route methods from configured plugins", () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          routes() {
            return [
              {
                method: "TRACE" as never,
                path: "/demo",
                handler: () => new Response("demo"),
              },
            ];
          },
        },
      }),
    ]);
    try {
      expect(() =>
        getPluginRoutes({
          resourceEvents: { publish: async () => {} },
        }),
      ).toThrow(
        'Plugin route "/demo" from plugin "agent-demo" has invalid method "TRACE"',
      );
    } finally {
      setPlugins(previous);
    }
  });

  it("rejects routes that combine ALL with explicit methods", () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          routes() {
            return [
              {
                method: ["ALL", "GET"],
                path: "/demo",
                handler: () => new Response("demo"),
              },
            ];
          },
        },
      }),
    ]);
    try {
      expect(() =>
        getPluginRoutes({
          resourceEvents: { publish: async () => {} },
        }),
      ).toThrow(
        'Plugin route "/demo" from plugin "agent-demo" must not combine ALL with explicit methods',
      );
    } finally {
      setPlugins(previous);
    }
  });

  it("rejects route paths that mix ALL and explicit method registrations", () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          routes() {
            return [
              {
                method: "ALL",
                path: "/demo",
                handler: () => new Response("demo"),
              },
              {
                method: "GET",
                path: "/demo",
                handler: () => new Response("demo"),
              },
            ];
          },
        },
      }),
    ]);
    try {
      expect(() =>
        getPluginRoutes({
          resourceEvents: { publish: async () => {} },
        }),
      ).toThrow(
        'Plugin route "/demo" conflicts with an ALL route for the same path',
      );
    } finally {
      setPlugins(previous);
    }
  });

  it("collects API route apps from configured plugins", async () => {
    let resolveUser: ((email: string) => Promise<unknown>) | undefined;
    let receivedContext: unknown;
    const viewer = {
      email: "person@example.com",
      id: "user-1",
      identities: [],
    };
    resolveViewerUserMock.mockResolvedValue(viewer);
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          apiRoutes(ctx) {
            resolveUser = ctx.users.resolve;
            return {
              fetch: (_request, context) => {
                receivedContext = context;
                return new Response("api demo");
              },
            };
          },
        },
      }),
    ]);
    try {
      const routes = getPluginApiRoutes();

      expect(routes).toHaveLength(1);
      expect(routes[0]?.pluginName).toBe("agent-demo");
      await expect(resolveUser?.("person@example.com")).resolves.toEqual(
        viewer,
      );
      expect(resolveViewerUserMock).toHaveBeenCalledWith("person@example.com");
      const response = await routes[0]!.app.fetch(
        new Request("http://localhost/demo"),
        {
          auth: {
            user: {
              email: "person@example.com",
              emailVerified: true,
            },
          },
          pluginName: "agent-demo",
        },
      );
      await expect(response.text()).resolves.toBe("api demo");
      expect(receivedContext).not.toHaveProperty("viewer");
    } finally {
      setPlugins(previous);
    }
  });

  it("rejects invalid API route apps from configured plugins", () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          apiRoutes() {
            return {} as never;
          },
        },
      }),
    ]);
    try {
      expect(() => getPluginApiRoutes()).toThrow(
        'Plugin apiRoutes hook from plugin "agent-demo" must return a fetch-compatible app',
      );
    } finally {
      setPlugins(previous);
    }
  });

  it("rejects unsafe Slack conversation links from configured plugins", () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          slackConversationLink() {
            return { url: "javascript:alert(1)" };
          },
        },
      }),
    ]);
    try {
      expect(() => getPluginSlackConversationLink("slack:C1:123")).toThrow(
        'Plugin "agent-demo" slackConversationLink must return an absolute http(s) URL',
      );
    } finally {
      setPlugins(previous);
    }
  });

  it("collects operational reports from configured plugins", async () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          async operationalReport(ctx) {
            expect(ctx.nowMs).toBe(123);
            expect("set" in ctx.state).toBe(false);
            await expect(ctx.state.get("dashboard-test")).resolves.toBe(
              undefined,
            );
            return {
              title: "Agent Demo",
              metrics: [{ label: "active", value: "1" }],
              widgets: [
                {
                  categories: [
                    {
                      id: " 30d ",
                      label: " 30 days ",
                      values: { " created ": 4, ignored: 99 },
                    },
                  ],
                  description: " Rolling activity ",
                  id: " activity ",
                  series: [
                    { key: " created ", label: " Created ", tone: "good" },
                  ],
                  title: " Activity ",
                  type: "bar_chart",
                },
              ],
            };
          },
        },
      }),
    ]);
    try {
      await expect(getPluginOperationalReports(123)).resolves.toEqual([
        {
          pluginName: "agent-demo",
          title: "Agent Demo",
          metrics: [{ label: "active", value: "1" }],
          widgets: [
            {
              categories: [
                {
                  id: "30d",
                  label: "30 days",
                  values: { created: 4 },
                },
              ],
              description: "Rolling activity",
              id: "activity",
              series: [{ key: "created", label: "Created", tone: "good" }],
              title: "Activity",
              type: "bar_chart",
            },
          ],
        },
      ]);
    } finally {
      setPlugins(previous);
    }
  });

  it("keeps the newest chart categories when sanitizing bounded reports", async () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          operationalReport() {
            return {
              widgets: [
                {
                  categories: Array.from({ length: 101 }, (_, index) => ({
                    id: `day-${index + 1}`,
                    label: `Day ${index + 1}`,
                    values: { created: index + 1 },
                  })),
                  id: "activity",
                  series: [{ key: "created", label: "Created" }],
                  title: "Activity",
                  type: "bar_chart" as const,
                },
              ],
            };
          },
        },
      }),
    ]);
    try {
      const reports = await getPluginOperationalReports(123);
      expect(reports[0]?.widgets?.[0]?.categories).toHaveLength(100);
      expect(reports[0]?.widgets?.[0]?.categories[0]?.id).toBe("day-2");
      expect(reports[0]?.widgets?.[0]?.categories.at(-1)?.id).toBe("day-101");
    } finally {
      setPlugins(previous);
    }
  });

  it("contains failed operational reports per plugin", async () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          operationalReport() {
            return {
              title: "Agent Demo",
              metrics: [{ label: "active", value: "1" }],
            };
          },
        },
      }),
      defineJuniorPlugin({
        manifest: {
          name: "broken-demo",
          displayName: "Broken Demo",
          description: "Broken demo",
        },
        hooks: {
          operationalReport() {
            throw new Error("database unavailable");
          },
        },
      }),
    ]);
    try {
      await expect(getPluginOperationalReports(123)).resolves.toEqual([
        {
          pluginName: "agent-demo",
          title: "Agent Demo",
          metrics: [{ label: "active", value: "1" }],
        },
        {
          generatedAt: "1970-01-01T00:00:00.123Z",
          pluginName: "broken-demo",
          recordSets: [
            {
              emptyText: "This plugin report failed to load.",
              title: "Error",
            },
          ],
          metrics: [{ label: "report", tone: "danger", value: "failed" }],
          title: "broken-demo",
        },
      ]);
    } finally {
      setPlugins(previous);
    }
  });

  it("collects profile reports and skips plugin failures", async () => {
    const subject = {
      email: "subject@example.com",
      id: "user-subject",
      identities: [],
    };
    const viewer = {
      email: "viewer@example.com",
      id: "user-viewer",
      identities: [],
    };
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          async profileReport(ctx) {
            expect(ctx.nowMs).toBe(123);
            expect(ctx.subject).toEqual(subject);
            expect(ctx.viewer).toEqual(viewer);
            expect("set" in ctx.state).toBe(false);
            return {
              title: "Agent Demo",
              metrics: [{ label: "prs", value: "2" }],
            };
          },
        },
      }),
      defineJuniorPlugin({
        manifest: {
          name: "broken-demo",
          displayName: "Broken Demo",
          description: "Broken demo",
        },
        hooks: {
          profileReport() {
            throw new Error("database unavailable");
          },
        },
      }),
      defineJuniorPlugin({
        manifest: {
          name: "empty-demo",
          displayName: "Empty Demo",
          description: "Empty demo",
        },
        hooks: {
          profileReport() {
            return undefined;
          },
        },
      }),
    ]);
    try {
      await expect(
        getPluginProfileReports({ nowMs: 123, subject, viewer }),
      ).resolves.toEqual([
        {
          pluginName: "agent-demo",
          title: "Agent Demo",
          metrics: [{ label: "prs", value: "2" }],
        },
      ]);
    } finally {
      setPlugins(previous);
    }
  });

  it("runs sandbox and tool lifecycle hooks from configured plugins", async () => {
    const writes: Array<{ content: string | Uint8Array; path: string }> = [];
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          async sandboxPrepare(ctx) {
            expect(ctx.actor).toEqual(TEST_ACTOR);
            await ctx.sandbox.writeFile({
              path: `${ctx.sandbox.juniorRoot}/prepared.txt`,
              content: TEST_ACTOR.userId,
            });
          },
          beforeToolExecute(ctx) {
            expect(ctx.actor).toEqual(TEST_ACTOR);
            // No `actors` getter was passed to createPluginHookRunner, so the
            // hook context falls back to the single run actor.
            expect(ctx.actors).toEqual([TEST_ACTOR]);
            ctx.env.set("AGENT_PLUGIN", TEST_ACTOR.userId);
            if (
              typeof ctx.tool.input === "object" &&
              ctx.tool.input &&
              "command" in ctx.tool.input &&
              ctx.tool.input.command === "replace me"
            ) {
              ctx.decision.replaceInput({
                ...ctx.tool.input,
                command: "replaced",
              });
            }
            if (
              typeof ctx.tool.input === "object" &&
              ctx.tool.input &&
              "command" in ctx.tool.input &&
              ctx.tool.input.command === "blocked"
            ) {
              ctx.decision.deny("blocked by plugin");
            }
          },
        },
      }),
    ]);
    try {
      const runner = createPluginHookRunner({
        actor: TEST_ACTOR,
      });

      await runner.prepareSandbox(fakeSandbox(writes));
      expect(writes).toEqual([
        {
          path: "/vercel/sandbox/.junior/prepared.txt",
          content: "U123",
        },
      ]);

      await expect(
        runner.beforeToolExecute({
          name: "bash",
          input: { command: "blocked" },
        }),
      ).rejects.toThrow("blocked by plugin");

      const before = await runner.beforeToolExecute({
        name: "bash",
        input: {
          command: "replace me",
          env: { PUBLIC_MODE: "preview" },
        },
      });
      expect(before.input).toEqual({
        command: "replaced",
        env: { PUBLIC_MODE: "preview" },
      });
      expect(before.env).toEqual({ AGENT_PLUGIN: "U123" });
    } finally {
      setPlugins(previous);
    }
  });

  it("runs Workspace preparation non-interactively with owner cancellation", async () => {
    const runCommand = vi.fn(async (_input: SandboxCommandInput) => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          async workspacePrepare(ctx) {
            await ctx.sandbox.run({
              cmd: "git",
              args: ["clone", "https://example.com/demo.git", "demo"],
              cwd: ctx.sandbox.root,
            });
          },
        },
      }),
    ]);
    try {
      const controller = new AbortController();
      const sandbox = {
        ...fakeSandbox([]),
        runCommand,
      };

      await createPluginHookRunner().prepareWorkspace(
        sandbox,
        [
          {
            provider: "agent-demo",
            repo: "example/demo",
          },
        ],
        controller.signal,
      );

      expect(runCommand).toHaveBeenCalledTimes(1);
      const command = runCommand.mock.calls[0]?.[0];
      expect(command).toMatchObject({
        cmd: "bash",
        cwd: "/vercel/sandbox",
        signal: controller.signal,
      });
      expect(command?.args?.[0]).toBe("-c");
      expect(command?.args?.[1]).toContain("GIT_TERMINAL_PROMPT");
      expect(command?.args?.[1]).toContain(
        "'git' 'clone' 'https://example.com/demo.git' 'demo'",
      );
    } finally {
      setPlugins(previous);
    }
  });

  it("rejects unhandled Workspace repository providers before preparation", async () => {
    const workspacePrepare = vi.fn(async () => {});
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: { workspacePrepare },
      }),
    ]);
    try {
      await expect(
        createPluginHookRunner().prepareWorkspace(fakeSandbox([]), [
          {
            provider: "agent-demo",
            repo: "example/demo",
          },
          {
            provider: "missing-provider",
            repo: "example/missing",
          },
        ]),
      ).rejects.toThrow(
        "Workspace repository providers have no preparation hook: missing-provider",
      );
      expect(workspacePrepare).not.toHaveBeenCalled();
    } finally {
      setPlugins(previous);
    }
  });

  it("rejects colliding Workspace checkout paths from short repository names", async () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "github",
          displayName: "GitHub",
          description: "GitHub",
        },
        hooks: {
          async workspacePrepare() {},
        },
      }),
    ]);
    try {
      await expect(
        createPluginHookRunner().prepareWorkspace(fakeSandbox([]), [
          {
            provider: "github",
            repo: "getsentry/sentry",
          },
          {
            provider: "github",
            repo: "acme/sentry",
          },
        ]),
      ).rejects.toThrow("Workspace checkout path collision: repos/sentry");
    } finally {
      setPlugins(previous);
    }
  });

  it("materializes beforeToolExecute actors from the live actors getter per call", async () => {
    const seenActorSets: unknown[][] = [];
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          beforeToolExecute(ctx) {
            seenActorSets.push(ctx.actors ?? []);
          },
        },
      }),
    ]);
    const SECOND_ACTOR = {
      platform: "slack",
      teamId: "T123",
      userId: "U456",
    } as const;
    // Mirrors how the run threads committed instruction provenance: the
    // getter reads live state, so mid-run growth (steering) is visible to
    // the next tool call without re-creating the hook runner.
    let liveActors: unknown[] = [TEST_ACTOR];
    try {
      const runner = createPluginHookRunner({
        actor: TEST_ACTOR,
        actors: () => liveActors as never,
      });

      await runner.beforeToolExecute({ name: "bash", input: {} });
      liveActors = [TEST_ACTOR, SECOND_ACTOR];
      await runner.beforeToolExecute({ name: "bash", input: {} });

      expect(seenActorSets).toEqual([[TEST_ACTOR], [TEST_ACTOR, SECOND_ACTOR]]);
    } finally {
      setPlugins(previous);
    }
  });
});

describe("getPluginTools channel resolution", () => {
  function capturePluginContext(
    context: ToolRuntimeContext = {
      conversationId: LOCAL_DESTINATION.conversationId,
      destination: LOCAL_DESTINATION,
      egress: TEST_EGRESS,
      source: LOCAL_SOURCE,
      workspace: {} as any,
    },
  ) {
    let captured: ToolRegistrationHookContext | undefined;
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "capture",
          displayName: "Capture",
          description: "Capture plugin context",
        },
        hooks: {
          tools(ctx) {
            captured = ctx;
            return {};
          },
        },
      }),
    ]);
    getPluginTools(context);
    setPlugins(previous);
    if (!captured) {
      throw new Error("capture plugin tools hook was not called");
    }
    return captured;
  }

  it("passes runtime-owned destination directly to plugin hooks", () => {
    const source = slackSource("DDM");
    const ctx = capturePluginContext({
      conversationId: "slack:DDM:1712345.0001",
      source,
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "COUT",
      },
      egress: TEST_EGRESS,
      workspace: {} as any,
    });
    expect(ctx.source).toEqual(source);
    expect(ctx.destination).toEqual({
      platform: "slack",
      teamId: "T123",
      channelId: "COUT",
    });
  });

  it("computes channelCapabilities from the Conversation Location", () => {
    // DM channel: canvas and reactions yes, standalone channel-post no
    const ctx = capturePluginContext({
      conversationId: "slack:DDM:1712345.0001",
      source: slackSource("DDM"),
      location: {
        id: "location:T123:DDM",
        provider: "slack",
        teamId: "T123",
        channelId: "DDM",
        threadTs: "1712345.0001",
      },
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "COUT",
      },
      egress: TEST_EGRESS,
      workspace: {} as any,
    });
    expect(ctx.slack?.channelCapabilities.canCreateCanvas).toBe(true);
    expect(ctx.slack?.channelCapabilities.canAddReactions).toBe(true);
    expect(ctx.slack?.channelCapabilities.canPostToChannel).toBe(false);
  });

  it("exposes Slack context and Actor for an Agent invocation", () => {
    const ctx = capturePluginContext({
      conversationId: "agent-invocation:invocation-1",
      source: { kind: "agent_invocation" },
      actor: TEST_ACTOR,
      destination: SLACK_DESTINATION,
      location: {
        id: "location:T123:DDM",
        provider: "slack",
        teamId: "T123",
        channelId: "DDM",
      },
      egress: TEST_EGRESS,
      workspace: {} as any,
    });

    expect(ctx.source).toEqual({ kind: "agent_invocation" });
    expect(ctx.actor).toEqual(TEST_ACTOR);
    expect(ctx.slack?.channelCapabilities.canCreateCanvas).toBe(true);
  });

  it("creates a direct credential subject when channelId is a DM", () => {
    const ctx = capturePluginContext({
      conversationId: "slack:DDM:1712345.0001",
      source: slackSource("DDM"),
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "COUT",
      },
      egress: TEST_EGRESS,
      actor: TEST_ACTOR,
      workspace: {} as any,
    });

    expect(ctx.slack?.credentialSubject).toMatchObject({
      type: "user",
      userId: "U123",
      allowedWhen: "private-direct-conversation",
    });
  });

  it("does not create a credential subject when channelId is not a DM", () => {
    const ctx = capturePluginContext({
      conversationId: "slack:DDM:1712345.0001",
      source: slackSource("CSOURCE"),
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "COUT",
      },
      egress: TEST_EGRESS,
      actor: TEST_ACTOR,
      workspace: {} as any,
    });

    expect(ctx.slack?.credentialSubject).toBeUndefined();
  });

  it("exposes conversationId to plugins", () => {
    const ctx = capturePluginContext({
      conversationId: "slack:DDM:1780479160.406339",
      destination: SLACK_DESTINATION,
      egress: TEST_EGRESS,
      source: SLACK_SOURCE,
      workspace: {} as any,
    });

    expect(ctx.conversationId).toBe("slack:DDM:1780479160.406339");
  });

  it("exposes db to plugin hooks", () => {
    const ctx = capturePluginContext();

    expect(ctx.db).toEqual(expect.any(Object));
  });

  it("does not synthesize Slack context from local destinations", () => {
    const ctx = capturePluginContext();
    expect(ctx.destination).toEqual(LOCAL_DESTINATION);
    expect(ctx.source).toEqual(LOCAL_SOURCE);
    expect(ctx.slack).toBeUndefined();
  });
});
