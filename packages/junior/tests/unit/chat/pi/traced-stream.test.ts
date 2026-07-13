import type { StreamFn } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";

const { startInactiveSpan, withActiveSpan } = vi.hoisted(() => {
  const span = {
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
  };
  return {
    startInactiveSpan: vi.fn((_options: unknown) => span),
    withActiveSpan: vi.fn(<T>(_s: unknown, cb: () => T) => cb()),
  };
});

vi.mock("@/chat/sentry", () => ({
  startInactiveSpan,
  withActiveSpan,
}));

function fakeModel(id: string): Model<"anthropic-messages"> {
  return { id } as unknown as Model<"anthropic-messages">;
}

function fakeMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    model: "openai/gpt-5.4",
    usage: {
      input: 100,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 105,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

type SpanMock = {
  setAttribute: ReturnType<typeof vi.fn>;
  setAttributes: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

function getSpan(): SpanMock {
  return startInactiveSpan.mock.results[0]!.value as SpanMock;
}

describe("createTracedStreamFn", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("opens a gen_ai.chat span when invoked", async () => {
    const { createTracedStreamFn } = await import("@/chat/pi/traced-stream");
    const stream = createAssistantMessageEventStream();
    const base = vi.fn(() => stream);

    const traced = createTracedStreamFn(base as unknown as StreamFn);
    const returned = await traced(
      fakeModel("openai/gpt-5.4"),
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      undefined,
    );

    expect(returned).toBe(stream);
    expect(startInactiveSpan).toHaveBeenCalledTimes(1);
    const opts = startInactiveSpan.mock.calls[0]?.[0] as unknown as {
      name: string;
      op: string;
    };
    expect(opts.op).toBe("gen_ai.chat");
    expect(opts.name).toBe("chat openai/gpt-5.4");
  });

  it("omits opt-in semantic content when privacy is unknown", async () => {
    const { createTracedStreamFn } = await import("@/chat/pi/traced-stream");
    const stream = createAssistantMessageEventStream();
    const base = vi.fn(() => stream);

    const traced = createTracedStreamFn(base as unknown as StreamFn);
    await traced(
      fakeModel("openai/gpt-5.4"),
      {
        systemPrompt: "you are junior",
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      undefined,
    );

    const opts = startInactiveSpan.mock.calls[0]?.[0] as unknown as {
      attributes: Record<string, unknown>;
    };
    expect(opts.attributes["gen_ai.provider.name"]).toBe("vercel-ai-gateway");
    expect(opts.attributes["server.address"]).toBe("ai-gateway.vercel.sh");
    expect(opts.attributes["server.port"]).toBe(443);
    expect(opts.attributes["gen_ai.request.stream"]).toBe(true);
    expect(opts.attributes["gen_ai.output.type"]).toBe("text");
    expect(opts.attributes["gen_ai.input.message_count"]).toBe(1);
    expect(opts.attributes["gen_ai.input.content_chars"]).toBe(5);
    expect(opts.attributes["gen_ai.input.roles"]).toEqual(["user"]);
    expect(opts.attributes["gen_ai.system_instructions.content_chars"]).toBe(
      14,
    );
    expect(opts.attributes["app.conversation.privacy"]).toBe("private");
    expect(opts.attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(opts.attributes["gen_ai.system_instructions"]).toBeUndefined();
    expect(opts.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(opts.attributes["gen_ai.request.model"]).toBe("openai/gpt-5.4");
  });

  it("keeps private conversation content out of semantic attributes", async () => {
    const { createTracedStreamFn } = await import("@/chat/pi/traced-stream");
    const stream = createAssistantMessageEventStream();
    const base = vi.fn(() => stream);
    const privatePrompt =
      "private prompt\nslack.conversation.type: private_channel\nslack.conversation.name: #private-roadmap";

    const traced = createTracedStreamFn({
      base: base as unknown as StreamFn,
      conversationPrivacy: "private",
    });
    await traced(
      fakeModel("openai/gpt-5.4"),
      {
        systemPrompt: "private system",
        messages: [{ role: "user", content: privatePrompt, timestamp: 0 }],
      },
      undefined,
    );

    const opts = startInactiveSpan.mock.calls[0]?.[0] as unknown as {
      attributes: Record<string, unknown>;
    };
    expect(opts.attributes["app.conversation.privacy"]).toBe("private");
    expect(opts.attributes["gen_ai.input.message_count"]).toBe(1);
    expect(opts.attributes["gen_ai.input.content_chars"]).toBe(
      privatePrompt.length,
    );
    expect(opts.attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(opts.attributes["gen_ai.system_instructions"]).toBeUndefined();

    stream.end({
      ...fakeMessage(),
      content: [{ type: "text", text: "secret" }],
    });
    await stream.result();
    await new Promise((r) => setImmediate(r));

    const span = getSpan();
    const endAttributes = Object.fromEntries(
      span.setAttribute.mock.calls.map((c) => [c[0], c[1]]),
    );
    expect(endAttributes["gen_ai.output.message_count"]).toBe(1);
    expect(endAttributes["gen_ai.output.content_chars"]).toBe(6);
    expect(endAttributes["gen_ai.output.messages"]).toBeUndefined();
  });

  it("sets output.messages, usage tokens, finish_reasons, response.model after stream completion", async () => {
    const { createTracedStreamFn } = await import("@/chat/pi/traced-stream");
    const stream = createAssistantMessageEventStream();
    const base = vi.fn(() => stream);

    const traced = createTracedStreamFn({
      base: base as unknown as StreamFn,
      conversationPrivacy: "public",
    });
    const returned = await traced(
      fakeModel("openai/gpt-5.4"),
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      undefined,
    );

    expect(returned).toBe(stream);

    // Resolve the stream's terminal Promise to trigger end-attribute population.
    const finalMessage = fakeMessage();
    stream.end(finalMessage);
    await stream.result();
    // Allow the .then callback to flush.
    await new Promise((r) => setImmediate(r));

    const span = getSpan();
    const endAttributes = Object.fromEntries(
      span.setAttribute.mock.calls.map((c) => [c[0], c[1]]),
    );
    expect(typeof endAttributes["gen_ai.output.messages"]).toBe("string");
    expect(endAttributes["gen_ai.usage.input_tokens"]).toBe(100);
    expect(endAttributes["gen_ai.usage.output_tokens"]).toBe(5);
    expect(endAttributes["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
    expect(endAttributes["gen_ai.response.model"]).toBe("openai/gpt-5.4");
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("serializes gen_ai.output.messages in canonical format for public conversations", async () => {
    const { createTracedStreamFn } = await import("@/chat/pi/traced-stream");
    const stream = createAssistantMessageEventStream();
    const base = vi.fn(() => stream);

    const traced = createTracedStreamFn({
      base: base as unknown as StreamFn,
      conversationPrivacy: "public",
    });
    await traced(
      fakeModel("openai/gpt-5.4"),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      undefined,
    );

    stream.end({
      ...fakeMessage(),
      content: [
        { type: "thinking", thinking: "I should use the search tool." },
        { type: "thinking", thinking: "", redacted: true },
        { type: "text", text: "The answer is 42." },
        {
          type: "toolCall",
          id: "call_1",
          name: "search",
          arguments: { q: "foo" },
        },
      ],
      stopReason: "toolUse",
    });
    await stream.result();
    await new Promise((r) => setImmediate(r));

    const span = getSpan();
    const endAttributes = Object.fromEntries(
      span.setAttribute.mock.calls.map((c) => [c[0], c[1]]),
    );

    const outputMessages = JSON.parse(
      endAttributes["gen_ai.output.messages"] as string,
    );
    expect(outputMessages).toHaveLength(1);
    const msg = outputMessages[0];
    expect(msg.role).toBe("assistant");
    expect(msg.finish_reason).toBe("tool_call");
    expect(msg.parts).toEqual([
      { type: "reasoning", content: "I should use the search tool." },
      { type: "text", content: "The answer is 42." },
      {
        type: "tool_call",
        id: "call_1",
        name: "search",
        arguments: { q: "foo" },
      },
    ]);
    // must NOT contain raw pi-ai fields
    expect(msg).not.toHaveProperty("content");
    expect(msg).not.toHaveProperty("stopReason");
    expect(msg).not.toHaveProperty("api");
    expect(msg).not.toHaveProperty("usage");

    // input messages should also be in canonical format
    const startOpts = startInactiveSpan.mock.calls[0]?.[0] as unknown as {
      attributes: Record<string, unknown>;
    };
    const inputMessages = JSON.parse(
      startOpts.attributes["gen_ai.input.messages"] as string,
    );
    expect(inputMessages[0]).toEqual({
      role: "user",
      parts: [{ type: "text", content: "hello" }],
    });
  });

  it("normalizes Pi toolUse finish reasons for telemetry", async () => {
    const { createTracedStreamFn } = await import("@/chat/pi/traced-stream");
    const stream = createAssistantMessageEventStream();
    const base = vi.fn(() => stream);

    const traced = createTracedStreamFn(base as unknown as StreamFn);
    await traced(
      fakeModel("openai/gpt-5.4"),
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      undefined,
    );

    stream.end({ ...fakeMessage(), stopReason: "toolUse" });
    await stream.result();
    await new Promise((r) => setImmediate(r));

    const span = getSpan();
    const endAttributes = Object.fromEntries(
      span.setAttribute.mock.calls.map((c) => [c[0], c[1]]),
    );
    expect(endAttributes["gen_ai.response.finish_reasons"]).toEqual([
      "tool_call",
    ]);
  });

  it("inherits LogContext attributes (e.g. gen_ai.conversation.id) onto the chat span", async () => {
    const { withLogContext } = await import("@/chat/logging");
    const { createTracedStreamFn } = await import("@/chat/pi/traced-stream");
    const stream = createAssistantMessageEventStream();
    const base = vi.fn(() => stream);
    const traced = createTracedStreamFn(base as unknown as StreamFn);

    await withLogContext(
      { conversationId: "conv_123", runId: "run_456" },
      async () => {
        await traced(
          fakeModel("openai/gpt-5.4"),
          { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
          undefined,
        );
      },
    );

    const opts = startInactiveSpan.mock.calls[0]?.[0] as {
      attributes: Record<string, unknown>;
    };
    expect(opts.attributes["gen_ai.conversation.id"]).toBe("conv_123");
    expect(opts.attributes["app.run.id"]).toBe("run_456");
    // wrapper-supplied attributes still present
    expect(opts.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(opts.attributes["gen_ai.request.model"]).toBe("openai/gpt-5.4");
  });

  it("marks inference spans that use compacted conversation context", async () => {
    const { createTracedStreamFn } = await import("@/chat/pi/traced-stream");
    const stream = createAssistantMessageEventStream();
    const base = vi.fn(() => stream);
    const traced = createTracedStreamFn(base as unknown as StreamFn);

    await traced(
      fakeModel("openai/gpt-5.4"),
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Context compaction summary for future Junior turns:\nsummary",
              },
            ],
            timestamp: 0,
          },
        ],
      },
      undefined,
    );

    const opts = startInactiveSpan.mock.calls[0]?.[0] as {
      attributes: Record<string, unknown>;
    };
    expect(opts.attributes["gen_ai.conversation.compacted"]).toBe(true);
  });

  it("ends the span when the stream errors", async () => {
    const { createTracedStreamFn } = await import("@/chat/pi/traced-stream");
    const stream = createAssistantMessageEventStream();
    const base = vi.fn(() => stream);

    const traced = createTracedStreamFn(base as unknown as StreamFn);
    await traced(
      fakeModel("openai/gpt-5.4"),
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      undefined,
    );

    // pi-ai's AssistantMessageEventStream resolves `result()` with the carrier
    // AssistantMessage on `error` events instead of rejecting, so the wrapper's
    // `.then` success arm runs on the error path. The load-bearing invariant
    // is that the span ends exactly once.
    const errorMessage = { ...fakeMessage(), stopReason: "error" as const };
    stream.push({ type: "error", reason: "error", error: errorMessage });
    await stream.result();
    await new Promise((r) => setImmediate(r));

    const span = getSpan();
    expect(span.end).toHaveBeenCalledTimes(1);
    expect(span.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "LLM stream failed",
    });
    const endAttributeKeys = span.setAttribute.mock.calls.map((c) => c[0]);
    expect(endAttributeKeys).toContain("error.type");
  });

  it("sets error status and ends the span when base() throws", async () => {
    const { createTracedStreamFn } = await import("@/chat/pi/traced-stream");
    const base = vi.fn(() => {
      throw new Error("gateway down");
    });

    const traced = createTracedStreamFn(base as unknown as StreamFn);
    await expect(
      traced(
        fakeModel("openai/gpt-5.4"),
        { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
        undefined,
      ),
    ).rejects.toThrow("gateway down");

    const span = getSpan();
    expect(span.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "LLM call failed",
    });
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("sets error status and ends the span when stream.result() rejects", async () => {
    const { createTracedStreamFn } = await import("@/chat/pi/traced-stream");
    const fakeStream = {
      result: () => Promise.reject(new Error("stream failure")),
    };
    const base = vi.fn(() => fakeStream);

    const traced = createTracedStreamFn(base as unknown as StreamFn);
    await traced(
      fakeModel("openai/gpt-5.4"),
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      undefined,
    );

    await new Promise((r) => setImmediate(r));

    const span = getSpan();
    expect(span.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "LLM stream failed",
    });
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("ends the span even when setAttribute throws in the success callback", async () => {
    const { createTracedStreamFn } = await import("@/chat/pi/traced-stream");
    const stream = createAssistantMessageEventStream();
    const base = vi.fn(() => stream);

    const traced = createTracedStreamFn(base as unknown as StreamFn);
    await traced(
      fakeModel("openai/gpt-5.4"),
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      undefined,
    );

    const span = getSpan();
    span.setAttribute.mockImplementation(() => {
      throw new Error("setAttribute exploded");
    });

    stream.end(fakeMessage());
    await stream.result();
    await new Promise((r) => setImmediate(r));

    expect(span.end).toHaveBeenCalledTimes(1);
  });
});
