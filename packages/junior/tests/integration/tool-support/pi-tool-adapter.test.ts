import { describe, expect, it, vi } from "vitest";
import {
  createLocalSource,
  defineJuniorPlugin,
  pluginToolOutputSchema,
  zodTool,
} from "@sentry/junior-plugin-api";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { createTools } from "@/chat/tools";
import { createPiAgentTools } from "@/chat/tool-support/pi-tool-adapter";
import { tool, type AnyToolDefinition } from "@/chat/tools/definition";

const customerResultSchema = pluginToolOutputSchema.extend({
  customer_id: z.string(),
  status_text: z.string(),
});

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
    conversationId: LOCAL_DESTINATION.conversationId,
    destination: LOCAL_DESTINATION,
    egress: TEST_EGRESS,
    source: LOCAL_SOURCE,
    workspace: {} as any,
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
    const actionReview = {
      projectToolResult: <T>(_: string, result: T) => result,
      review: vi.fn(async () => ({
        decision: "allow" as const,
        reason: "Read-only lookup requested by the user.",
        riskLevel: "low" as const,
        userAuthorization: "high" as const,
      })),
    };
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
              lookupCustomer: zodTool({
                annotations: {
                  destructiveHint: false,
                  idempotentHint: true,
                  openWorldHint: true,
                  readOnlyHint: true,
                },
                description: "Lookup customer health for account review.",
                inputSchema: z.object({
                  customerId: z
                    .string()
                    .min(1)
                    .describe("Customer identifier to inspect."),
                  note: z
                    .string()
                    .optional()
                    .describe("Optional account note."),
                }),
                outputSchema: customerResultSchema,
                prepareArguments: (args) => {
                  const input = args as Record<string, unknown>;
                  return typeof input.customer_id === "string"
                    ? { customerId: input.customer_id }
                    : (input as { customerId: string });
                },
                execute: async ({ customerId }) =>
                  ({
                    customer_id: customerId,
                    status_text: "healthy",
                  }) as const,
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
        undefined,
        "private",
        undefined,
        actionReview,
      );

      expect(registry.agentDemo_lookupCustomer?.exposure).toBe("deferred");
      expect(registry.agentDemo_lookupCustomer?.source).toEqual({
        id: "agent-demo",
        description: "Agent demo",
      });
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
            source: "agent-demo",
            input_schema: {
              properties: {
                customerId: {
                  description: "Customer identifier to inspect.",
                  minLength: 1,
                  type: "string",
                },
                note: {
                  description: "Optional account note.",
                  type: "string",
                },
              },
              required: ["customerId"],
              type: "object",
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

      expect(executeResult.details).toMatchObject({
        customer_id: "C123",
        status_text: "healthy",
      });
      expect(onToolCall).toHaveBeenCalledWith(
        "tool-execute",
        "agentDemo_lookupCustomer",
        {
          customerId: "C123",
        },
      );
      expect(actionReview.review).toHaveBeenCalledWith(
        "tool-execute",
        "agentDemo_lookupCustomer",
        registry.agentDemo_lookupCustomer,
        { customerId: "C123" },
        undefined,
      );
    } finally {
      setPlugins(previousPlugins);
    }
  });

  it("keeps direct tools native-visible and executable through executeTool", async () => {
    const definitions: Record<string, AnyToolDefinition> = {
      directDemo: tool({
        description: "Direct demo",
        inputSchema: Type.Object({}),
        execute: async () => ({ tool: "directDemo" }),
      }),
      hiddenDemo: tool({
        description: "Hidden demo",
        exposure: "hidden",
        inputSchema: Type.Object({}),
        execute: async () => ({ tool: "hiddenDemo" }),
      }),
      catalogOnlyDemo: tool({
        description: "Catalog-only demo",
        exposure: "deferred",
        inputSchema: Type.Object({}),
        execute: async () => ({ tool: "catalogOnlyDemo" }),
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
    ).resolves.toMatchObject({ details: { tool: "directDemo" } });
    await expect(
      executeTool.execute("tool-catalog-only", {
        tool_name: "catalogOnlyDemo",
        arguments: {},
      }),
    ).resolves.toMatchObject({ details: { tool: "catalogOnlyDemo" } });
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
