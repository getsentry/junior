import { describe, expect, it, vi } from "vitest";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";

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

function assistantResponse(): StreamResponse {
  const message = {
    role: "assistant" as const,
    api: "test",
    provider: "test",
    model: "test",
    usage,
    stopReason: "stop" as const,
    content: [{ type: "text" as const, text: "done" }],
    timestamp: Date.now(),
  };

  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done" as const };
    },
    result: async () => message,
  } as unknown as StreamResponse;
}

describe("Pi Agent lifecycle", () => {
  it("converts prepareNextTurn exceptions into error turns", async () => {
    const prepareError = new Error("prepare hook failed");
    const prepareNextTurn = vi.fn(async () => {
      throw prepareError;
    });
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
        tools: [],
      },
      prepareNextTurn,
      streamFn: async () => assistantResponse(),
    });

    await expect(agent.prompt("hello")).resolves.toBeUndefined();

    expect(prepareNextTurn).toHaveBeenCalledOnce();
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: prepareError.message,
    });
  });
});
