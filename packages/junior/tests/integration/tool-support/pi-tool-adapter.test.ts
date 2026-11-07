import { describe, expect, it, vi } from "vitest";
import {
  createLocalSource,
  defineJuniorPlugin,
  pluginToolOutputSchema,
  zodTool,
} from "@sentry/junior-plugin-api";
import { Type } from "@sinclair/typebox";
import * as z from "zod";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { createTools } from "@/chat/tools";
import { createPiAgentTools } from "@/chat/tool-support/pi-tool-adapter";
import type { ToolActionReview } from "@/chat/guardian/gate";
import {
  disableTools,
  tool,
  type AnyToolDefinition,
} from "@/chat/tools/definition";

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
      review: vi.fn<ToolActionReview["review"]>(
        async (actions) =>
          new Map(
            actions.map((action) => [
              action.toolCallId,
              {
                allowed: true,
                decision: {
                  decision: "allow",
                  reason: "Read-only lookup requested by the user.",
                  riskLevel: "low",
                  userAuthorization: "high",
                },
              },
            ]),
          ),
      ),
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
        { query: "lookupCustomer", source: "agent-demo" },
      );
      expect(searchResult.details).toMatchObject({
        returned_tools: 1,
        source: "agent-demo",
        tools: [
          {
            tool_name: "agentDemo_lookupCustomer",
            // source is omitted on tools when the search already selected one.
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
        [
          {
            toolCallId: "tool-execute",
            toolName: "agentDemo_lookupCustomer",
            tool: registry.agentDemo_lookupCustomer,
            input: { customerId: "C123" },
          },
        ],
        undefined,
      );
    } finally {
      setPlugins(previousPlugins);
    }
  });

  it("lists and runs each tool only for its exposure", async () => {
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
      modelOnlyDemo: tool({
        description: "Model-only demo",
        exposure: "modelOnly",
        inputSchema: Type.Object({}),
        execute: async () => ({ tool: "modelOnlyDemo" }),
      }),
      codemodeDemo: tool({
        description: "Code Mode demo",
        exposure: "codemode",
        inputSchema: Type.Object({}),
        execute: async () => ({ tool: "codemodeDemo" }),
      }),
    };
    const tools = createPiAgentTools(definitions, new SkillSandbox([], []), {});
    const executeTool = agentTool(tools, "executeTool");

    expect(tools.map((candidate) => candidate.name).sort()).toEqual([
      "directDemo",
      "executeTool",
      "modelOnlyDemo",
      "searchTools",
    ]);
    await expect(
      agentTool(tools, "modelOnlyDemo").execute("tool-model-only", {}),
    ).resolves.toMatchObject({ details: { tool: "modelOnlyDemo" } });
    for (const toolName of ["modelOnlyDemo", "codemodeDemo"]) {
      await expect(
        executeTool.execute(`tool-${toolName}`, {
          tool_name: toolName,
          arguments: {},
        }),
      ).rejects.toThrow("can only call catalog tools");
    }
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

  it("keeps model-only runtime tools out of the tool catalog", async () => {
    const spawnAgent = vi.fn();
    const messageAgent = vi.fn();
    const registry = createTools(
      [],
      {},
      {
        ...runtimeContext(),
        automation: { sendsMessage: false },
        messageAgent,
        agentInvocationId: "invocation-1",
        parentConversationId: "local:test:parent",
        spawnAgent,
      },
    );
    const tools = createPiAgentTools(registry, new SkillSandbox([], []), {});
    const modelOnlyTools = [
      "finishAutomationRun",
      "messageAgent",
      "reportBlocked",
      "spawnAgent",
    ];

    expect(tools.map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining(modelOnlyTools),
    );
    for (const toolName of modelOnlyTools) {
      await expect(
        agentTool(tools, "executeTool").execute(`catalog-${toolName}`, {
          tool_name: toolName,
          arguments: {},
        }),
      ).rejects.toThrow("can only call catalog tools");
    }
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(messageAgent).not.toHaveBeenCalled();
  });

  it("keeps a disabled tool in the model tool list but rejects its calls", async () => {
    const execute = vi.fn(async () => ({ tool: "notify" }));
    const definitions: Record<string, AnyToolDefinition> = {
      notify: tool({
        description: "Notify a person",
        inputSchema: Type.Object({ text: Type.String() }),
        execute,
      }),
      catalogNotify: tool({
        description: "Notify from the catalog",
        exposure: "deferred",
        inputSchema: Type.Object({ text: Type.String() }),
        execute,
      }),
    };
    const sandbox = new SkillSandbox([], []);
    const enabled = createPiAgentTools(definitions, sandbox, {});
    const disabled = createPiAgentTools(
      disableTools(definitions, "It needs a person's message."),
      sandbox,
      {},
    );
    const modelView = (tools: ReturnType<typeof createPiAgentTools>) =>
      JSON.stringify(
        tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      );

    // The provider caches the tool list, so disabling must not change it.
    expect(modelView(disabled)).toBe(modelView(enabled));
    await expect(
      agentTool(disabled, "notify").execute("disabled-direct", { text: "hi" }),
    ).rejects.toThrow(
      "notify is disabled in this Turn. It needs a person's message.",
    );
    await expect(
      agentTool(disabled, "executeTool").execute("disabled-catalog", {
        tool_name: "catalogNotify",
        arguments: { text: "hi" },
      }),
    ).rejects.toThrow("catalogNotify is disabled in this Turn.");
    expect(execute).not.toHaveBeenCalled();
  });
});
