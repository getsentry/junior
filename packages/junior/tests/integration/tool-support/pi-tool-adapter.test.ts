import { describe, expect, it, vi } from "vitest";
import {
  createLocalSource,
  defineJuniorPlugin,
} from "@sentry/junior-plugin-api";
import { Type } from "@sinclair/typebox";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { createTools } from "@/chat/tools";
import { createPiAgentTools } from "@/chat/tool-support/pi-tool-adapter";
import { tool, type AnyToolDefinition } from "@/chat/tools/definition";

const LOCAL_DESTINATION = {
  platform: "local",
  conversationId: "local:test:pi-tool-adapter",
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

function agentTool(tools: ReturnType<typeof createPiAgentTools>, name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`Missing agent tool: ${name}`);
  }
  return found;
}

describe("Pi tool adapter integration", () => {
  it("discovers and executes plugin tools through catalog tool primitives", async () => {
    const onToolCall = vi.fn();
    const previousPlugins = setPlugins([
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

    try {
      const registry = createTools([], {}, runtimeContext());
      const tools = createPiAgentTools(
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
        tools.some(
          (candidate) => candidate.name === "agentDemo_lookupCustomer",
        ),
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
            input_schema_summary: "customerId (required)",
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
    } finally {
      setPlugins(previousPlugins);
    }
  });

  it("keeps direct tools native-visible and executable through executeTool", async () => {
    const definitions: Record<string, AnyToolDefinition> = {
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
      catalogOnlyDemo: tool({
        description: "Catalog-only demo",
        exposure: "deferred",
        inputSchema: Type.Object({}),
        execute: async () => ({ ok: true }),
      }),
    };
    const tools = createPiAgentTools(definitions, new SkillSandbox([], []), {});
    const executeTool = agentTool(tools, "executeTool");

    expect(tools.map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining(["directDemo", "searchTools", "executeTool"]),
    );
    await expect(
      executeTool.execute("tool-direct", {
        tool_name: "directDemo",
        arguments: {},
      }),
    ).resolves.toMatchObject({ details: { ok: true } });
    await expect(
      executeTool.execute("tool-catalog-only", {
        tool_name: "catalogOnlyDemo",
        arguments: {},
      }),
    ).resolves.toMatchObject({ details: { ok: true } });
    await expect(
      executeTool.execute("tool-hidden", {
        tool_name: "hiddenDemo",
        arguments: {},
      }),
    ).rejects.toThrow("can only call catalog tools");
    await expect(
      executeTool.execute("tool-missing", {
        tool_name: "missingDemo",
        arguments: {},
      }),
    ).rejects.toThrow("can only call catalog tools");
  });
});
