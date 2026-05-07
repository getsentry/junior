import { afterEach, describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import {
  Agent,
  type AgentTool,
  type StreamFn,
} from "@mariozechner/pi-agent-core";
import {
  createEchoMcpTestServer,
  type EchoMcpTestServer,
} from "../fixtures/mcp-test-server";

type StreamResponse = Awaited<ReturnType<StreamFn>>;

const usage = {
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
};

function exposedToolSummary(provider: string, tool: AgentTool) {
  return {
    tool_name: tool.name,
    mcp_tool_name: tool.name.replace(`mcp__${provider}__`, ""),
    provider,
    description: tool.description,
    input_schema: tool.parameters,
    input_schema_summary: "value (required)",
  };
}

function assistantMessage(content: Array<Record<string, unknown>>) {
  return {
    role: "assistant" as const,
    api: "test",
    provider: "test",
    model: "test",
    usage,
    stopReason: content.some((part) => part.type === "toolCall")
      ? "toolCalls"
      : "stop",
    content,
    timestamp: Date.now(),
  };
}

function responseFor(message: ReturnType<typeof assistantMessage>) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done" as const };
    },
    result: async () => message,
  } as unknown as StreamResponse;
}

describe("MCP tools loaded mid-turn", () => {
  let mcp: EchoMcpTestServer | undefined;

  afterEach(async () => {
    await mcp?.close();
    mcp = undefined;
  });

  it("loads MCP tools mid-run and executes them through static bridge tools", async () => {
    mcp = await createEchoMcpTestServer();

    const activeMcpTools: AgentTool[] = [];
    const tools: AgentTool[] = [
      {
        name: "loadSkill",
        label: "loadSkill",
        description: "Load a skill and activate its provider tools",
        parameters: Type.Object({}),
        execute: async () => {
          const listedTools = (await mcp!.client.listTools()).tools;
          activeMcpTools.splice(
            0,
            activeMcpTools.length,
            ...listedTools.map(
              (listedTool): AgentTool => ({
                name: `mcp__${mcp!.provider}__${listedTool.name}`,
                label: `mcp__${mcp!.provider}__${listedTool.name}`,
                description: listedTool.description ?? listedTool.name,
                parameters:
                  listedTool.inputSchema as unknown as AgentTool["parameters"],
                execute: async (_toolCallId, params) => {
                  const result = await mcp!.client.callTool({
                    name: listedTool.name,
                    arguments:
                      params && typeof params === "object"
                        ? (params as Record<string, unknown>)
                        : undefined,
                  });
                  return {
                    content:
                      "content" in result && Array.isArray(result.content)
                        ? result.content
                        : [{ type: "text", text: "ok" }],
                    details: result,
                  };
                },
              }),
            ),
          );
          return {
            content: [{ type: "text", text: "loaded" }],
            details: {
              mcp_provider: mcp!.provider,
              available_tool_count: activeMcpTools.length,
            },
          };
        },
      },
      {
        name: "searchMcpTools",
        label: "searchMcpTools",
        description: "Search active MCP tool descriptors",
        parameters: Type.Object({
          query: Type.Optional(Type.String()),
          provider: Type.Optional(Type.String()),
        }),
        execute: async () => ({
          content: [{ type: "text", text: "found" }],
          details: {
            tools: activeMcpTools.map((tool) =>
              exposedToolSummary(mcp!.provider, tool),
            ),
          },
        }),
      },
      {
        name: "callMcpTool",
        label: "callMcpTool",
        description: "Call an active MCP tool by disclosed name",
        parameters: Type.Object({
          tool_name: Type.String(),
          arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        }),
        execute: async (_toolCallId, params) => {
          const input = params as {
            tool_name: string;
            arguments?: Record<string, unknown>;
          };
          const activeTool = activeMcpTools.find(
            (tool) => tool.name === input.tool_name,
          );
          if (!activeTool) {
            throw new Error(`Inactive MCP tool: ${input.tool_name}`);
          }
          return await activeTool.execute(_toolCallId, input.arguments ?? {});
        },
      },
    ];
    const toolsSeenByModel: string[][] = [];
    let callCount = 0;

    const agent = new Agent({
      initialState: {
        systemPrompt: "System prompt",
        model: {
          id: "test",
          name: "test",
          api: "test",
          provider: "test",
          baseUrl: "",
          reasoning: false,
          input: [],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 0,
          maxTokens: 0,
        },
        thinkingLevel: "off",
        tools,
      },
      streamFn: async (_model, context) => {
        toolsSeenByModel.push(context.tools?.map((tool) => tool.name) ?? []);
        callCount += 1;
        if (callCount === 1) {
          return responseFor(
            assistantMessage([
              {
                type: "toolCall",
                id: "load-1",
                name: "loadSkill",
                arguments: {},
              },
            ]),
          );
        }
        if (callCount === 2) {
          return responseFor(
            assistantMessage([
              {
                type: "toolCall",
                id: "search-1",
                name: "searchMcpTools",
                arguments: { provider: mcp!.provider },
              },
            ]),
          );
        }
        if (callCount === 3) {
          return responseFor(
            assistantMessage([
              {
                type: "toolCall",
                id: "echo-1",
                name: "callMcpTool",
                arguments: {
                  tool_name: mcp!.toolName,
                  arguments: { value: "hello" },
                },
              },
            ]),
          );
        }
        return responseFor(assistantMessage([{ type: "text", text: "done" }]));
      },
    });

    await agent.prompt({
      role: "user",
      content: [{ type: "text", text: "use the MCP tool" }],
      timestamp: Date.now(),
    });

    expect(toolsSeenByModel[0]).toEqual([
      "loadSkill",
      "searchMcpTools",
      "callMcpTool",
    ]);
    expect(toolsSeenByModel[1]).toEqual([
      "loadSkill",
      "searchMcpTools",
      "callMcpTool",
    ]);
    expect(toolsSeenByModel[2]).toEqual([
      "loadSkill",
      "searchMcpTools",
      "callMcpTool",
    ]);
    expect(agent.state.messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "searchMcpTools",
        details: expect.objectContaining({
          tools: [
            expect.objectContaining({
              tool_name: mcp.toolName,
              input_schema: expect.any(Object),
            }),
          ],
        }),
        isError: false,
      }),
    );
    expect(agent.state.messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "callMcpTool",
        content: [{ type: "text", text: "echo:hello" }],
        isError: false,
      }),
    );
  });
});
