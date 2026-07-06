import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalSource,
  defineJuniorPlugin,
} from "@sentry/junior-plugin-api";
import { Type } from "@sinclair/typebox";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { createTools } from "@/chat/tools";
import { createAgentTools } from "@/chat/tools/agent-tools";
import { tool } from "@/chat/tools/definition";

const LOCAL_DESTINATION = {
  platform: "local",
  conversationId: "local:test:deferred-tools",
} as const;
const LOCAL_SOURCE = createLocalSource(LOCAL_DESTINATION.conversationId);
const TEST_EGRESS = {
  async fetch() {
    return new Response("ok");
  },
};

function runtimeContext() {
  return {
    destination: LOCAL_DESTINATION,
    egress: TEST_EGRESS,
    source: LOCAL_SOURCE,
    sandbox: {} as any,
  };
}

function agentTool(tools: ReturnType<typeof createAgentTools>, name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`Missing agent tool: ${name}`);
  }
  return found;
}

describe("deferred tools", () => {
  afterEach(() => {
    setPlugins([]);
  });

  it("discovers and executes plugin tools through the deferred tool primitives", async () => {
    const onToolCall = vi.fn();
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "agent-demo",
          displayName: "Agent Demo",
          description: "Agent demo",
        },
        hooks: {
          tools() {
            return {
              lookupCustomer: tool({
                description: "Lookup customer health for account review.",
                inputSchema: Type.Object(
                  {
                    customerId: Type.String({
                      minLength: 1,
                      description: "Customer identifier to inspect.",
                    }),
                  },
                  { additionalProperties: false },
                ),
                prepareArguments: (args) => {
                  const input = args as Record<string, unknown>;
                  return typeof input.customer_id === "string"
                    ? { customerId: input.customer_id }
                    : (input as { customerId: string });
                },
                execute: async ({ customerId }) => ({
                  customer_id: customerId,
                  status: "healthy",
                }),
              }),
            };
          },
        },
      }),
    ]);

    const registry = createTools([], {}, runtimeContext());
    const tools = createAgentTools(
      registry,
      new SkillSandbox([], []),
      {},
      undefined,
      undefined,
      undefined,
      onToolCall,
    );

    expect(registry.agentDemo_lookupCustomer?.exposure).toBe("deferred");
    expect(tools.map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining(["searchTools", "executeTool"]),
    );
    expect(
      tools.some((candidate) => candidate.name === "agentDemo_lookupCustomer"),
    ).toBe(false);

    const searchResult = await agentTool(tools, "searchTools").execute(
      "tool-search",
      { query: "customer identifier" },
    );
    expect(searchResult.details).toMatchObject({
      returned_tools: 1,
      tools: [
        {
          tool_name: "agentDemo_lookupCustomer",
          source: {
            type: "plugin",
            plugin: "agent-demo",
          },
        },
      ],
    });

    const executeResult = await agentTool(tools, "executeTool").execute(
      "tool-execute",
      {
        tool_name: "agentDemo_lookupCustomer",
        arguments: { customer_id: "C123" },
      },
    );

    expect(executeResult.details).toEqual({
      customer_id: "C123",
      status: "healthy",
    });
    expect(onToolCall).toHaveBeenCalledWith("agentDemo_lookupCustomer", {
      customerId: "C123",
    });
    await expect(
      agentTool(tools, "executeTool").execute("tool-invalid", {
        tool_name: "agentDemo_lookupCustomer",
        arguments: {},
      }),
    ).rejects.toThrow("arguments do not match schema");
  });

  it("does not let executeTool call direct, hidden, or unknown tools", async () => {
    const tools = createAgentTools(
      {
        directDemo: tool({
          description: "Direct demo",
          inputSchema: Type.Object({}),
          execute: async () => ({ ok: true }),
        }),
        hiddenDemo: tool({
          description: "Hidden demo",
          exposure: "hidden",
          inputSchema: Type.Object({}),
          execute: async () => ({ ok: true }),
        }),
        deferredDemo: tool({
          description: "Deferred demo",
          exposure: "deferred",
          inputSchema: Type.Object({}),
          execute: async () => ({ ok: true }),
        }),
      },
      new SkillSandbox([], []),
      {},
    );
    const executeTool = agentTool(tools, "executeTool");

    await expect(
      executeTool.execute("tool-direct", {
        tool_name: "directDemo",
        arguments: {},
      }),
    ).rejects.toThrow("can only call deferred tools");
    await expect(
      executeTool.execute("tool-hidden", {
        tool_name: "hiddenDemo",
        arguments: {},
      }),
    ).rejects.toThrow("can only call deferred tools");
    await expect(
      executeTool.execute("tool-missing", {
        tool_name: "missingDemo",
        arguments: {},
      }),
    ).rejects.toThrow("can only call deferred tools");
  });
});
