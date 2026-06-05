import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { DEFAULT_TEST_NOW_MS } from "./vitest";

type StreamResponse = Awaited<ReturnType<StreamFn>>;
type AssistantMessage = Extract<Message, { role: "assistant" }>;

const zeroUsage = {
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

/** Build a Pi assistant message for deterministic streamFn tests. */
export function piAssistantMessage(
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant" as const,
    api: "test",
    provider: "test",
    model: "test",
    usage: zeroUsage,
    stopReason: content.some((part) => part.type === "toolCall")
      ? "toolUse"
      : "stop",
    content,
    timestamp: DEFAULT_TEST_NOW_MS,
  };
}

/** Build the AsyncIterable/result pair expected from a Pi streamFn. */
export function piStreamResponse(
  message: ReturnType<typeof piAssistantMessage>,
): StreamResponse {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done" as const };
    },
    result: async () => message,
  } as unknown as StreamResponse;
}

/** Build a Pi streamFn response that asks the agent to call one tool. */
export function piToolCallResponse(args: {
  id: string;
  name: string;
  parameters?: Record<string, unknown>;
}): StreamResponse {
  return piStreamResponse(
    piAssistantMessage([
      {
        type: "toolCall",
        id: args.id,
        name: args.name,
        arguments: args.parameters ?? {},
      },
    ]),
  );
}

/** Build a Pi streamFn response with one terminal text assistant message. */
export function piTextResponse(text: string): StreamResponse {
  return piStreamResponse(
    piAssistantMessage([
      {
        type: "text",
        text,
      },
    ]),
  );
}
