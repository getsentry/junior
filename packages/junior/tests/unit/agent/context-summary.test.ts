import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  buildAgentModelRequest,
  requestContextSummary,
} from "@/chat/agent/context-summary";

const model = {
  id: "anthropic/claude-test",
  api: "anthropic-messages",
  provider: "vercel-ai-gateway",
} as Model<"anthropic-messages">;

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

type Call = { context: Context; options: SimpleStreamOptions };

const LOOP_CONFIG_KEYS = new Set([
  "afterToolCall",
  "beforeToolCall",
  "convertToLlm",
  "getApiKey",
  "getFollowUpMessages",
  "getSteeringMessages",
  "model",
  "prepareNextTurn",
  "shouldStopAfterTurn",
  "signal",
  "toolExecution",
  "transformContext",
]);

/** A stream function that answers each call with the next message. */
function replies(messages: AssistantMessage[]): {
  calls: Call[];
  streamFn: StreamFn;
} {
  const calls: Call[] = [];
  const streamFn: StreamFn = (_model, context, options) => {
    const message = messages[calls.length]!;
    calls.push({
      context: { ...context, messages: [...context.messages] },
      options: options ?? {},
    });
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: message.stopReason as "stop" | "length" | "toolUse",
        message,
      });
    });
    return stream;
  };
  return { calls, streamFn };
}

function createAgent(streamFn: StreamFn): Agent {
  return new Agent({
    getApiKey: () => "gateway-key",
    sessionId: "conversation-1",
    streamFn,
    thinkingBudgets: { low: 1_024 },
    initialState: {
      model,
      systemPrompt: "You are a helper.",
      thinkingLevel: "low",
      tools: [
        {
          name: "lookup",
          label: "Lookup",
          description: "Look up a record.",
          parameters: Type.Object({ id: Type.String() }),
          execute: async () => ({ content: [], details: undefined }),
        },
      ],
    },
  });
}

describe("context summary", () => {
  it("builds the request that the Pi agent loop sends", async () => {
    const { calls, streamFn } = replies([
      assistant([{ type: "text", text: "Done." }]),
    ]);
    const agent = createAgent(streamFn);
    await agent.prompt("Fix the failing check.");

    const request = await buildAgentModelRequest(
      agent,
      agent.state.messages.slice(0, -1),
    );

    expect(request.model).toBe(model);
    expect(request.context).toEqual(calls[0]!.context);
    // Pi passes its whole loop config as options. Providers read only the
    // request fields, so compare those and skip the loop hooks.
    const requestOptions = (options: SimpleStreamOptions) =>
      Object.fromEntries(
        Object.entries(options).filter(
          ([key, value]) => value !== undefined && !LOOP_CONFIG_KEYS.has(key),
        ),
      );
    expect(requestOptions(request.options)).toEqual(
      requestOptions(calls[0]!.options),
    );
    expect(request.options.reasoning).toBe("low");
  });

  it("appends one instruction to the request and returns the summary", async () => {
    const { calls, streamFn } = replies([
      assistant([
        { type: "thinking", thinking: "Collect the open work." },
        { type: "text", text: "<summary>\n## Goal\n- Fix CI\n</summary>" },
      ]),
    ]);
    const request = await buildAgentModelRequest(createAgent(streamFn), [
      { role: "user", content: "Fix the failing check.", timestamp: 0 },
    ]);

    const summary = await requestContextSummary(request, streamFn);

    expect(summary).toBe("## Goal\n- Fix CI");
    expect(calls).toHaveLength(1);
    const { context, options } = calls[0]!;
    expect(context.systemPrompt).toBe(request.context.systemPrompt);
    expect(context.tools).toEqual(request.context.tools);
    expect(context.messages.slice(0, -1)).toEqual(request.context.messages);
    expect(context.messages.at(-1)).toMatchObject({ role: "user" });
    expect(options).toMatchObject({
      reasoning: request.options.reasoning,
      sessionId: request.options.sessionId,
    });
  });

  it("nudges once and fails when no complete summary comes back", async () => {
    const { calls, streamFn } = replies([
      assistant(
        [
          {
            type: "toolCall",
            id: "call-1",
            name: "lookup",
            arguments: { id: "1" },
          },
        ],
        "toolUse",
      ),
      assistant([{ type: "text", text: "<summary>## Goal" }], "length"),
    ]);
    const request = await buildAgentModelRequest(createAgent(streamFn), [
      { role: "user", content: "Fix the failing check.", timestamp: 0 },
    ]);

    await expect(requestContextSummary(request, streamFn)).rejects.toThrow(
      "Context summary failed: max_tokens",
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]!.context.messages.slice(0, -1)).toEqual(
      calls[0]!.context.messages,
    );
  });
});
