import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  readAgentHistory,
  withAgentRequest,
  writeAgentHistory,
} from "@/chat/pi/agent-history";
import type { PiMessage } from "@/chat/pi/messages";

const model = {
  id: "anthropic/claude-test",
  api: "anthropic-messages",
  provider: "vercel-ai-gateway",
} as Model<"anthropic-messages">;

// Later Pi versions keep the prompt and tools in system messages. The
// installed Pi has no such type, so build one by shape.
function system(text: string): PiMessage {
  const message: Record<string, unknown> = {
    role: "system",
    systemPrompt: text,
    timestamp: 0,
  };
  return message as PiMessage & Record<string, unknown>;
}

function user(text: string): PiMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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
    stopReason: "stop",
    timestamp: 0,
  };
}

describe("agent history", () => {
  it("reads history without system messages", () => {
    const messages = [system("prompt"), user("a"), system("tools"), user("b")];

    expect(readAgentHistory(messages)).toEqual([user("a"), user("b")]);
  });

  it("writes history after the leading system message of the agent", () => {
    const current = [system("prompt"), user("old")];

    expect(
      writeAgentHistory(current, [system("saved"), user("a"), user("b")]),
    ).toEqual([system("prompt"), user("a"), user("b")]);
  });

  it("writes a copy of history when the agent has no system message", () => {
    const history = [user("a")];
    const written = writeAgentHistory([user("old")], history);

    expect(written).toEqual(history);
    expect(written).not.toBe(history);
  });

  it("sends Junior's prompt, tools, and history to the stream path", async () => {
    const tools = [
      {
        name: "lookup",
        label: "Lookup",
        description: "Look up a record.",
        parameters: Type.Object({ id: Type.String() }),
        execute: async () => ({ content: [], details: undefined }),
      },
    ];
    const contexts: Context[] = [];
    const base: StreamFn = (_model, context) => {
      contexts.push(context);
      const message = assistant("Done.");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    };
    const agent = new Agent({
      getApiKey: () => "gateway-key",
      streamFn: withAgentRequest(base, {
        systemPrompt: "You are a helper.",
        tools,
      }),
      initialState: { model, systemPrompt: "You are a helper.", tools },
    });

    await agent.prompt("Fix the failing check.");

    expect(contexts).toEqual([
      {
        systemPrompt: "You are a helper.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Fix the failing check." }],
            timestamp: expect.any(Number),
          },
        ],
        tools,
      },
    ]);
  });
});
