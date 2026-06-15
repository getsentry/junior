import {
  defineJuniorPlugin,
  type PluginConversations,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import {
  createPluginHookRunner,
  getPluginOperationalReports,
  getPluginRoutes,
  getPluginSlackConversationLink,
  getPluginTools,
  setPlugins,
} from "@/chat/plugins/agent-hooks";
import { createTools } from "@/chat/tools";
import { tool } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { Type } from "@sinclair/typebox";
import type { SandboxInstance } from "@/chat/sandbox/workspace";

const TEST_REQUESTER = {
  platform: "slack",
  teamId: "T123",
  userId: "U123",
} as const;

const LOCAL_DESTINATION = {
  platform: "local",
  conversationId: "local:test:agent-hooks",
} as const;

const EMPTY_CONVERSATIONS: PluginConversations = {
  async listRecent() {
    return [];
  },
};

const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "DDM",
} as const;

function fakeSandbox(
  writes: Array<{ content: string | Uint8Array; path: string }>,
): SandboxInstance {
  return {
    sandboxId: "sandbox-agent-hooks",
    sandboxEgressId: "session-agent-hooks",
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
        async stdout() {
          return "";
        },
        async stderr() {
          return "";
        },
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
  it("collects turn-scoped tools from configured plugins", () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          tools(ctx) {
            expect(ctx.requester).toEqual(TEST_REQUESTER);
            return {
              demoTool: tool({
                description: "Demo tool",
                inputSchema: Type.Object({}),
                execute: () => ({ ok: true }),
              }),
            };
          },
        },
      }),
    ]);
    try {
      const tools = getPluginTools({
        destination: SLACK_DESTINATION,
        requester: TEST_REQUESTER,
        source: SLACK_DESTINATION,
        sandbox: {} as any,
      });

      expect(tools).toHaveProperty("demoTool");
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
              "not-valid": tool({
                description: "Demo tool",
                inputSchema: Type.Object({}),
                execute: () => ({ ok: true }),
              }),
            };
          },
        },
      }),
    ]);
    try {
      expect(() =>
        getPluginTools({
          destination: LOCAL_DESTINATION,
          source: LOCAL_DESTINATION,
          sandbox: {} as any,
        }),
      ).toThrow("must be a camelCase identifier");
    } finally {
      setPlugins(previous);
    }
  });

  it("rejects plugin tools that conflict with core tools", () => {
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
              loadSkill: tool({
                description: "Demo tool",
                inputSchema: Type.Object({}),
                execute: () => ({ ok: true }),
              }),
            };
          },
        },
      }),
    ]);
    try {
      expect(() =>
        createTools(
          [],
          {},
          {
            destination: LOCAL_DESTINATION,
            source: LOCAL_DESTINATION,
            sandbox: {} as any,
          },
        ),
      ).toThrow('Plugin tool "loadSkill" conflicts with a core tool');
    } finally {
      setPlugins(previous);
    }
  });

  it("collects route handlers from configured plugins", async () => {
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
                path: "/demo",
                handler: () => new Response("demo"),
              },
            ];
          },
        },
      }),
    ]);
    try {
      const routes = getPluginRoutes();

      expect(routes).toHaveLength(1);
      expect(routes[0]?.pluginName).toBe("agent-demo");
      expect(routes[0]?.path).toBe("/demo");
      const response = await routes[0]!.handler(
        new Request("http://localhost/demo"),
      );
      await expect(response.text()).resolves.toBe("demo");
    } finally {
      setPlugins(previous);
    }
  });

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
      expect(() => getPluginRoutes()).toThrow(
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
      expect(() => getPluginRoutes()).toThrow(
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
      expect(() => getPluginRoutes()).toThrow(
        'Plugin route "/demo" conflicts with an ALL route for the same path',
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
            await expect(ctx.conversations.listRecent()).resolves.toEqual([]);
            return {
              title: "Agent Demo",
              metrics: [{ label: "active", value: "1" }],
            };
          },
        },
      }),
    ]);
    try {
      await expect(
        getPluginOperationalReports(123, EMPTY_CONVERSATIONS),
      ).resolves.toEqual([
        {
          pluginName: "agent-demo",
          title: "Agent Demo",
          metrics: [{ label: "active", value: "1" }],
        },
      ]);
    } finally {
      setPlugins(previous);
    }
  });

  it("passes conversation reader to operational reports", async () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          async operationalReport(ctx) {
            const conversations = await ctx.conversations.listRecent({
              limit: 1,
            });
            return {
              title: "Agent Demo",
              metrics: [
                {
                  label: "conversation",
                  value: conversations[0]?.displayTitle ?? "missing",
                },
              ],
            };
          },
        },
      }),
    ]);
    try {
      await expect(
        getPluginOperationalReports(123, {
          async listRecent() {
            return [
              {
                conversationId: "slack:C1:111",
                displayTitle: "Incident follow-up",
                lastActivityAt: "2026-06-01T00:00:00.000Z",
                lastUpdatedAt: "2026-06-01T00:00:00.000Z",
                status: "completed",
              },
            ];
          },
        }),
      ).resolves.toEqual([
        {
          pluginName: "agent-demo",
          title: "Agent Demo",
          metrics: [{ label: "conversation", value: "Incident follow-up" }],
        },
      ]);
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
      await expect(
        getPluginOperationalReports(123, EMPTY_CONVERSATIONS),
      ).resolves.toEqual([
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
            expect(ctx.requester).toEqual(TEST_REQUESTER);
            await ctx.sandbox.writeFile({
              path: `${ctx.sandbox.juniorRoot}/prepared.txt`,
              content: ctx.requester?.userId ?? "",
            });
          },
          beforeToolExecute(ctx) {
            expect(ctx.requester).toEqual(TEST_REQUESTER);
            ctx.env.set("AGENT_PLUGIN", ctx.requester?.userId ?? "");
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
        requester: TEST_REQUESTER,
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
        input: { command: "replace me" },
      });
      expect(before.input).toEqual({
        command: "replaced",
        env: { AGENT_PLUGIN: "U123" },
      });
      expect(before.env).toEqual({ AGENT_PLUGIN: "U123" });
    } finally {
      setPlugins(previous);
    }
  });
});

describe("getPluginTools channel resolution", () => {
  function capturePluginContext(
    context: ToolRuntimeContext = {
      destination: LOCAL_DESTINATION,
      source: LOCAL_DESTINATION,
      sandbox: {} as any,
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
    const ctx = capturePluginContext({
      source: {
        platform: "slack",
        teamId: "T123",
        channelId: "DDM",
      },
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "COUT",
      },
      sandbox: {} as any,
    });
    expect(ctx.source).toEqual({
      platform: "slack",
      teamId: "T123",
      channelId: "DDM",
    });
    expect(ctx.destination).toEqual({
      platform: "slack",
      teamId: "T123",
      channelId: "COUT",
    });
  });

  it("computes channelCapabilities from source channelId", () => {
    // DM channel: canvas and reactions yes, standalone channel-post no
    const ctx = capturePluginContext({
      source: {
        platform: "slack",
        teamId: "T123",
        channelId: "DDM",
      },
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "COUT",
      },
      sandbox: {} as any,
    });
    expect(ctx.slack?.channelCapabilities.canCreateCanvas).toBe(true);
    expect(ctx.slack?.channelCapabilities.canAddReactions).toBe(true);
    expect(ctx.slack?.channelCapabilities.canPostToChannel).toBe(false);
  });

  it("creates a direct credential subject when channelId is a DM", () => {
    const ctx = capturePluginContext({
      source: {
        platform: "slack",
        teamId: "T123",
        channelId: "DDM",
      },
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "COUT",
      },
      requester: TEST_REQUESTER,
      sandbox: {} as any,
    });

    expect(ctx.slack?.credentialSubject).toMatchObject({
      type: "user",
      userId: "U123",
      allowedWhen: "private-direct-conversation",
    });
  });

  it("does not create a credential subject when channelId is not a DM", () => {
    const ctx = capturePluginContext({
      source: {
        platform: "slack",
        teamId: "T123",
        channelId: "CSOURCE",
      },
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "COUT",
      },
      requester: TEST_REQUESTER,
      sandbox: {} as any,
    });

    expect(ctx.slack?.credentialSubject).toBeUndefined();
  });

  it("exposes conversationId to plugins", () => {
    const ctx = capturePluginContext({
      conversationId: "slack:DDM:1780479160.406339",
      destination: SLACK_DESTINATION,
      source: SLACK_DESTINATION,
      sandbox: {} as any,
    });

    expect(ctx.conversationId).toBe("slack:DDM:1780479160.406339");
  });

  it("does not synthesize Slack context from local destinations", () => {
    const ctx = capturePluginContext();
    expect(ctx.destination).toEqual(LOCAL_DESTINATION);
    expect(ctx.source).toEqual(LOCAL_DESTINATION);
    expect(ctx.slack).toBeUndefined();
  });
});
