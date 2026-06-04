import type { StreamFn } from "@earendil-works/pi-agent-core";

type StreamResponse = Awaited<ReturnType<StreamFn>>;

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
export function piAssistantMessage(content: Array<Record<string, unknown>>) {
  return {
    role: "assistant" as const,
    api: "test",
    provider: "test",
    model: "test",
    usage: zeroUsage,
    stopReason: content.some((part) => part.type === "toolCall")
      ? "toolCalls"
      : "stop",
    content,
    timestamp: Date.now(),
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
