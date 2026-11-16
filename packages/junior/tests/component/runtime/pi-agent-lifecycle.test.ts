import { describe, expect, it, vi } from "vitest";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { readAgentHistory, writeAgentHistory } from "@/chat/pi/agent-history";
import type { PiMessage } from "@/chat/pi/messages";
import { isAssistantMessage } from "@/chat/pi/transcript";
import { decideReply } from "@/chat/services/assistant-reply";
import { ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX } from "@/chat/services/context-compaction-marker";
import { nextEmptyOutputContinuation } from "@/chat/services/empty-output-continuation";

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

  // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done" as const };
    },
    result: async () => message,
  } as StreamResponse;
}

const testState = {
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
  thinkingLevel: "off" as const,
  tools: [],
};

describe("Pi Agent lifecycle", () => {
  it("converts turn_end listener exceptions into error turns", async () => {
    // Junior does its step work in an awaited `turn_end` listener and keeps
    // the error, because Pi reports it only as an error turn. Pi emits
    // `turn_end` again for that error turn.
    const listenerError = new Error("turn_end listener failed");
    const agent = new Agent({
      initialState: testState,
      streamFn: async () => assistantResponse(),
    });
    agent.subscribe(async (event) => {
      if (
        event.type === "turn_end" &&
        isAssistantMessage(event.message) &&
        event.message.stopReason !== "error"
      ) {
        throw listenerError;
      }
    });

    await expect(agent.prompt("hello")).resolves.toBeUndefined();

    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: listenerError.message,
    });
  });

  it("runs prepareNextTurn only before another model call", async () => {
    // Junior compacts in `turn_end`, so a final answer never reaches this
    // hook. Steering queued in `turn_end` starts one more model call.
    const prepareNextTurn = vi.fn(async () => undefined);
    const agent = new Agent({
      initialState: testState,
      prepareNextTurn,
      streamFn: async () => assistantResponse(),
    });
    let steered = false;
    agent.subscribe(async (event) => {
      if (event.type === "turn_end" && !steered) {
        steered = true;
        agent.steer({
          role: "user",
          content: [{ type: "text", text: "one more thing" }],
          timestamp: Date.now(),
        });
      }
    });

    await agent.prompt("hello");

    expect(prepareNextTurn).toHaveBeenCalledOnce();
    expect(
      readAgentHistory(agent.state.messages).map((message) => message.role),
    ).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("continues once after empty output without delivering it", async () => {
    const replies = ["", "Recovered."];
    const streamFn = vi.fn(async () => assistantResponse(replies.shift()));
    const delivered: string[] = [];
    const agent = new Agent({
      initialState: testState,
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
      messages: readAgentHistory(agent.state.messages as PiMessage[]),
    });
    expect(continuation).toMatchObject({
      kind: "retry",
    });
    if (continuation.kind !== "retry") {
      throw new Error("Expected empty output continuation");
    }

    agent.state.messages = writeAgentHistory(
      agent.state.messages as PiMessage[],
      continuation.messages,
    );
    await agent.continue();

    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual(["Recovered."]);
  });
});
