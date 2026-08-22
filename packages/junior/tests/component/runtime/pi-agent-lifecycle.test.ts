import { describe, expect, it, vi } from "vitest";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { PiMessage } from "@/chat/pi/messages";
import { isAssistantMessage } from "@/chat/pi/transcript";
import { decideReply } from "@/chat/services/assistant-reply";
import { ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX } from "@/chat/services/context-compaction-marker";
import { nextEmptyOutputContinuation } from "@/chat/services/empty-output-continuation";
import { castThroughUnknown } from "@sentry/junior-plugin-api";

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

function assistantResponse(text = "done"): StreamResponse {
  const message = {
    role: "assistant" as const,
    api: "test",
    provider: "test",
    model: "test",
    usage,
    stopReason: "stop" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  };

  return castThroughUnknown<StreamResponse>({
    async *[Symbol.asyncIterator]() {
      yield { type: "done" as const };
    },
    result: async () => message,
  });
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

  it("continues once after empty output without delivering it", async () => {
    const replies = ["", "Recovered."];
    const streamFn = vi.fn(async () => assistantResponse(replies.shift()));
    const delivered: string[] = [];
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
      streamFn,
    });
    agent.subscribe((event) => {
      if (event.type !== "message_end" || !isAssistantMessage(event.message)) {
        return;
      }
      const reply = decideReply(event.message);
      if (reply.kind === "deliver") {
        delivered.push(reply.text);
      }
    });

    await agent.prompt(
      `${ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX}\nContinue the task.`,
    );
    const lastAssistant = agent.state.messages
      .filter(isAssistantMessage)
      .at(-1);
    const continuation = nextEmptyOutputContinuation({
      attempt: 0,
      lastAssistant,
      messages: agent.state.messages as PiMessage[],
    });
    expect(continuation).toMatchObject({
      kind: "retry",
    });
    if (continuation.kind !== "retry") {
      throw new Error("Expected empty output continuation");
    }

    agent.state.messages = continuation.messages;
    await agent.continue();

    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual(["Recovered."]);
  });
});
