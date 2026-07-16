import {
  createLocalSource,
  createSlackSource,
  definePluginTool,
  defineJuniorPlugin,
  pluginToolResultSchema,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  createPluginHookRunner,
  getPluginApiRoutes,
  getPluginSystemPromptContributions,
  getPluginUserPromptContributions,
  getPluginOperationalReports,
  getPluginRoutes,
  getPluginSlackConversationLink,
  getPluginTools,
  setPlugins,
} from "@/chat/plugins/agent-hooks";
import { createTools } from "@/chat/tools";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import type { SandboxInstance } from "@/chat/sandbox/workspace";

const demoToolResultSchema = pluginToolResultSchema.extend({
  ok: z.literal(true),
  status: z.literal("success"),
});

function demoPluginTool(description = "Demo tool") {
  return definePluginTool({
    description,
    inputSchema: z.object({}),
    outputSchema: demoToolResultSchema,
    execute: () =>
      ({
        ok: true,
        status: "success",
      }) as const,
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
  type: "priv",
});

class PrototypeTool {
  description = "Prototype tool";
  inputSchema = z.toJSONSchema(z.object({}));
  outputSchema = z.toJSONSchema(demoToolResultSchema);

  execute() {
    return {
      ok: true,
      status: "success",
    } as const;
  }
}

function slackSource(channelId: string) {
  return createSlackSource({
    teamId: "T123",
    channelId,

    type: "priv",
  });
}

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
  it("accepts Slack source visibility from the runtime boundary", () => {
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "C123",
        type: "pub",
        threadTs: "1718800000.000000",
      }).type,
    ).toBe("pub");
    // Without a signal, C-prefixed channels fail closed to private.
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "C123",
        threadTs: "1718800000.000000",

        type: "priv",
      }).type,
    ).toBe("priv");
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "D123",
        threadTs: "1718800000.000000",

        type: "priv",
      }).type,
    ).toBe("priv");
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "G123",
        threadTs: "1718800000.000000",

        type: "priv",
      }).type,
    ).toBe("priv");
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
        getPluginSystemPromptContributions(LOCAL_SOURCE),
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
        getPluginSystemPromptContributions(LOCAL_SOURCE),
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
            expect(ctx).not.toHaveProperty("model");
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
            expect(ctx.actor).toEqual(TEST_ACTOR);
            return {
              demoTool: demoPluginTool(),
            };
          },
        },
      }),
    ]);
    try {
      const tools = getPluginTools({
        destination: SLACK_DESTINATION,
        actor: TEST_ACTOR,
        egress: TEST_EGRESS,
        source: SLACK_SOURCE,
        sandbox: {} as any,
      });

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
          tools() {
            return {
              prototypeTool,
            };
          },
        },
      }),
    ]);
    try {
      const tools = getPluginTools({
        destination: LOCAL_DESTINATION,
        egress: TEST_EGRESS,
        source: LOCAL_SOURCE,
        sandbox: {} as any,
      });

      expect(tools.agentDemo_prototypeTool).toBe(prototypeTool);
      expect(tools.prototypeTool).toBeUndefined();
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
        ok: true,
        status: "success",
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
        destination: LOCAL_DESTINATION,
        egress: TEST_EGRESS,
        source: LOCAL_SOURCE,
        sandbox: {} as any,
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
          destination: LOCAL_DESTINATION,
          egress: TEST_EGRESS,
          source: LOCAL_SOURCE,
          sandbox: {} as any,
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
          destination: LOCAL_DESTINATION,
          egress: TEST_EGRESS,
          source: LOCAL_SOURCE,
          sandbox: {} as any,
        },
      );
      expect(tools.loadSkill).toBeDefined();
      expect(tools.agentDemo_loadSkill).toBeDefined();
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

  it("collects API route apps from configured plugins", async () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          apiRoutes() {
            return {
              fetch: () => new Response("api demo"),
            };
          },
        },
      }),
    ]);
    try {
      const routes = getPluginApiRoutes();

      expect(routes).toHaveLength(1);
      expect(routes[0]?.pluginName).toBe("agent-demo");
      const response = await routes[0]!.app.fetch(
        new Request("http://localhost/demo"),
      );
      await expect(response.text()).resolves.toBe("api demo");
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
            };
          },
        },
      }),
    ]);
    try {
      await expect(
        getPluginOperationalReports(123),
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
        getPluginOperationalReports(123),
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
      destination: LOCAL_DESTINATION,
      egress: TEST_EGRESS,
      source: LOCAL_SOURCE,
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
    const source = slackSource("DDM");
    const ctx = capturePluginContext({
      source,
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "COUT",
      },
      egress: TEST_EGRESS,
      sandbox: {} as any,
    });
    expect(ctx.source).toEqual(source);
    expect(ctx.destination).toEqual({
      platform: "slack",
      teamId: "T123",
      channelId: "COUT",
    });
  });

  it("computes channelCapabilities from source channelId", () => {
    // DM channel: canvas and reactions yes, standalone channel-post no
    const ctx = capturePluginContext({
      source: slackSource("DDM"),
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "COUT",
      },
      egress: TEST_EGRESS,
      sandbox: {} as any,
    });
    expect(ctx.slack?.channelCapabilities.canCreateCanvas).toBe(true);
    expect(ctx.slack?.channelCapabilities.canAddReactions).toBe(true);
    expect(ctx.slack?.channelCapabilities.canPostToChannel).toBe(false);
  });

  it("creates a direct credential subject when channelId is a DM", () => {
    const ctx = capturePluginContext({
      source: slackSource("DDM"),
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "COUT",
      },
      egress: TEST_EGRESS,
      actor: TEST_ACTOR,
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
      source: slackSource("CSOURCE"),
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "COUT",
      },
      egress: TEST_EGRESS,
      actor: TEST_ACTOR,
      sandbox: {} as any,
    });

    expect(ctx.slack?.credentialSubject).toBeUndefined();
  });

  it("exposes conversationId to plugins", () => {
    const ctx = capturePluginContext({
      conversationId: "slack:DDM:1780479160.406339",
      destination: SLACK_DESTINATION,
      egress: TEST_EGRESS,
      source: SLACK_SOURCE,
      sandbox: {} as any,
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
