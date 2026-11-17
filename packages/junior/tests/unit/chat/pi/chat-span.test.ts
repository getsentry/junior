import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
  withChatRequestTelemetry,
  withChatSpanAttributes,
} from "@/chat/pi/chat-span";
import { COMPACTION_SUMMARY_PREFIX } from "@/chat/services/context-compaction-marker";

const sentry = vi.hoisted(() => ({
  activeSpan: undefined as unknown,
  origin: "auto.ai.pi_ai",
}));

vi.mock("@/chat/sentry", () => ({
  getActiveSpan: () => sentry.activeSpan,
  spanToJSON: () => ({ attributes: { "sentry.origin": sentry.origin } }),
}));

type SpanMock = {
  attributes: Record<string, unknown>;
  setAttribute: ReturnType<typeof vi.fn>;
  setAttributes: ReturnType<typeof vi.fn>;
};

// A span that the SDK's `piAiIntegration` has active while Pi calls the
// provider.
function activeChatSpan(): SpanMock {
  const attributes: Record<string, unknown> = {};
  const span = {
    attributes,
    setAttribute: vi.fn((key: string, value: unknown) => {
      attributes[key] = value;
    }),
    setAttributes: vi.fn((values: Record<string, unknown>) => {
      Object.assign(attributes, values);
    }),
  };
  sentry.activeSpan = span;
  return span;
}

const model = { id: "openai/gpt-5.4" } as Model<"anthropic-messages">;

function transcript(messages: Message[], systemPrompt?: string) {
  return normalizeContext({ systemPrompt, messages });
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

// Lets the relay read pushed events before the test continues.
function flushEvents(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

type Provider = StreamFunction<"anthropic-messages", SimpleStreamOptions>;

describe("withChatSpanAttributes", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    sentry.activeSpan = undefined;
    sentry.origin = "auto.ai.pi_ai";
  });

  it("calls the provider unchanged outside a pi-ai chat span", async () => {
    const stream = createAssistantMessageEventStream();
    const base = vi.fn<Provider>(() => stream);
    const options = { maxTokens: 1 };

    expect(withChatSpanAttributes(base)(model, transcript([]), options)).toBe(
      stream,
    );
    sentry.activeSpan = activeChatSpan();
    sentry.origin = "manual";
    expect(withChatSpanAttributes(base)(model, transcript([]), options)).toBe(
      stream,
    );
    expect(base).toHaveBeenCalledWith(model, expect.anything(), options);
  });

  it("describes the conversation messages without the system prompt", async () => {
    const span = activeChatSpan();
    const base = vi.fn<Provider>(() => createAssistantMessageEventStream());

    withChatRequestTelemetry(
      { attributes: { "gen_ai.prompt.name": "context_summary" } },
      () =>
        withChatSpanAttributes(base)(
          model,
          transcript(
            [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `${COMPACTION_SUMMARY_PREFIX}\nsummary`,
                  },
                ],
                timestamp: 0,
              },
              { role: "user", content: "hello", timestamp: 0 },
            ],
            "you are junior",
          ),
          undefined,
        ),
    );

    expect(span.attributes).toMatchObject({
      "app.conversation.privacy": "private",
      "gen_ai.conversation.compacted": true,
      "gen_ai.input.message_count": 2,
      "gen_ai.input.roles": ["user"],
      "gen_ai.system_instructions.content_chars": 14,
      "gen_ai.prompt.name": "context_summary",
    });
  });

  it("sets the end attributes before the returned stream settles", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(10_000);
    const span = activeChatSpan();
    const stream = createAssistantMessageEventStream();
    const returned = withChatRequestTelemetry(
      { endAttributes: () => ({ "app.compaction.next_input.size": 7 }) },
      () =>
        withChatSpanAttributes<"anthropic-messages">(() => stream)(
          model,
          transcript([{ role: "user", content: "hi", timestamp: 0 }]),
          undefined,
        ),
    );

    const finalMessage = {
      ...fakeMessage(),
      usage: { ...fakeMessage().usage, cacheRead: 300, cacheWrite1h: 3 },
    };
    const events: AssistantMessageEvent[] = [
      { type: "start", partial: finalMessage },
      { type: "text_start", contentIndex: 0, partial: finalMessage },
      { type: "done", reason: "stop", message: finalMessage },
    ];
    vi.setSystemTime(10_250);
    stream.push(events[0]!);
    await flushEvents();
    vi.setSystemTime(10_900);
    for (const event of events.slice(1)) {
      stream.push(event);
    }

    // The SDK ends the span when `result()` settles. The attributes must
    // already be there.
    const attributesAtSettle = await returned
      .result()
      .then(() => ({ ...span.attributes }));
    const received: AssistantMessageEvent[] = [];
    for await (const event of returned) {
      received.push(event);
    }

    expect(received).toEqual(events);
    expect(attributesAtSettle).toMatchObject({
      "app.ai.time_to_first_byte_ms": 250,
      "gen_ai.response.time_to_first_chunk": 0.9,
      "app.ai.first_token_type": "text_start",
      "app.ai.usage.cache_write_1h": 3,
      "gen_ai.usage.cache_hit_ratio": 0.75,
      "app.compaction.next_input.size": 7,
      "gen_ai.output.message_count": 1,
    });
  });

  it("records the provider error before the returned stream settles", async () => {
    const span = activeChatSpan();
    const stream = createAssistantMessageEventStream();
    const returned = withChatSpanAttributes<"anthropic-messages">(() => stream)(
      model,
      transcript([]),
      undefined,
    );

    const errorMessage = {
      ...fakeMessage(),
      stopReason: "error" as const,
      errorMessage: "upstream exploded",
    };
    stream.push({ type: "error", reason: "error", error: errorMessage });

    await expect(returned.result()).resolves.toBe(errorMessage);
    expect(span.attributes["error.type"]).toBeDefined();
    // An error before any event records no timing.
    expect(span.attributes["app.ai.time_to_first_byte_ms"]).toBeUndefined();
  });

  it("passes on a final message that ends the stream without an event", async () => {
    const span = activeChatSpan();
    const stream = createAssistantMessageEventStream();
    const returned = withChatSpanAttributes<"anthropic-messages">(() => stream)(
      model,
      transcript([]),
      undefined,
    );

    const finalMessage = fakeMessage();
    stream.end(finalMessage);

    await expect(returned.result()).resolves.toBe(finalMessage);
    expect(span.attributes["gen_ai.output.message_count"]).toBe(1);
  });

  it("hashes the provider request body and leaves it unchanged", async () => {
    // Runs one call whose provider builds `payload`, and returns the
    // `app.ai.request.*` attributes that the span got.
    const hashesFor = async (payload: Record<string, unknown>) => {
      const span = activeChatSpan();
      let hookResult: unknown = "not called";
      let sent: Promise<void> = Promise.resolve();
      const base: Provider = (requestModel, _context, options) => {
        sent = (async () => {
          hookResult = await options?.onPayload?.(payload, requestModel);
        })();
        return createAssistantMessageEventStream();
      };
      withChatSpanAttributes(base)(model, transcript([]), undefined);
      await sent;
      expect(hookResult).toBeUndefined();
      return Object.fromEntries(
        Object.entries(span.attributes).filter(([key]) =>
          key.startsWith("app.ai.request."),
        ),
      );
    };
    const breakpoint = { type: "ephemeral" };
    // Like Pi: the last user message becomes a text block with the
    // breakpoint, and earlier ones keep string content.
    const user = (text: string, cached = false) => ({
      role: "user",
      content: cached
        ? [{ type: "text", text, cache_control: breakpoint }]
        : text,
    });
    const reply = {
      role: "assistant",
      content: [{ type: "text", text: "a1" }],
    };
    const request = (
      messages: unknown[],
      description = "Search the web.",
      cached = true,
      effort = "high",
    ) => ({
      model: "anthropic/claude-opus-5.5",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort },
      system: [
        {
          type: "text",
          text: "you are junior",
          cache_control: cached ? breakpoint : undefined,
        },
      ],
      tools: [
        {
          name: "search",
          description,
          input_schema: { type: "object", properties: {} },
          cache_control: cached ? breakpoint : undefined,
        },
      ],
      messages,
    });

    const first = await hashesFor(request([user("u1", true)]));
    const appended = await hashesFor(
      request([user("u1"), reply, user("u2", true)]),
    );
    const edited = await hashesFor(
      request([user("u1 edited"), reply, user("u2", true)]),
    );
    const withoutBreakpoints = await hashesFor(
      request([user("u1"), reply, user("u2")], "Search the web.", false),
    );
    const otherTool = await hashesFor(
      request([user("u1", true)], "Search the internet."),
    );
    const otherEffort = await hashesFor(
      request([user("u1", true)], "Search the web.", true, "medium"),
    );

    expect(first["app.ai.request.tools.count"]).toBe(1);
    expect(first["app.ai.request.messages.count"]).toBe(1);
    expect(first["app.ai.request.tools.hash"]).toMatch(/^[0-9a-f]{16}$/);
    expect(first["app.ai.request.system_instructions.hash"]).toMatch(
      /^[0-9a-f]{16}$/,
    );
    expect(first).not.toHaveProperty(
      "app.ai.request.messages.before_last_reply.hash",
    );
    expect(appended["app.ai.request.messages.before_last_reply.hash"]).toBe(
      first["app.ai.request.messages.hash"],
    );
    expect(edited["app.ai.request.messages.before_last_reply.hash"]).not.toBe(
      first["app.ai.request.messages.hash"],
    );
    expect(appended["app.ai.request.prefix.before_last_reply.hash"]).toBe(
      first["app.ai.request.prefix.hash"],
    );
    expect(edited["app.ai.request.prefix.before_last_reply.hash"]).not.toBe(
      first["app.ai.request.prefix.hash"],
    );
    expect(first).not.toHaveProperty(
      "app.ai.request.prefix.before_last_reply.hash",
    );
    expect(first["app.ai.request.thinking.type"]).toBe("adaptive");
    expect(first["app.ai.request.effort"]).toBe("high");
    expect(otherEffort["app.ai.request.effort"]).toBe("medium");
    expect(otherEffort["app.ai.request.prefix.hash"]).not.toBe(
      first["app.ai.request.prefix.hash"],
    );
    for (const key of [
      "app.ai.request.tools.hash",
      "app.ai.request.system_instructions.hash",
      "app.ai.request.messages.hash",
    ]) {
      expect(otherEffort[key]).toBe(first[key]);
    }
    expect(withoutBreakpoints).toEqual(appended);
    expect(otherTool["app.ai.request.tools.hash"]).not.toBe(
      first["app.ai.request.tools.hash"],
    );
    expect(otherTool["app.ai.request.system_instructions.hash"]).toBe(
      first["app.ai.request.system_instructions.hash"],
    );

    // A 1920x1080 PNG header, and an image whose size cannot be read.
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.write("IHDR", 12, "latin1");
    png.writeUInt32BE(1920, 16);
    png.writeUInt32BE(1080, 20);
    const image = (mediaType: string, data: Buffer) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: data.toString("base64"),
      },
    });
    const withImages = await hashesFor(
      request([
        {
          role: "user",
          content: [image("image/png", png), { type: "text", text: "u1" }],
        },
        reply,
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: [image("image/jpeg", Buffer.from("not a jpeg"))],
            },
          ],
        },
      ]),
    );
    expect(withImages).toMatchObject({
      "app.ai.request.images.count": 2,
      // 2,691 for the PNG on the high-resolution tier, plus the flat 1,920.
      "app.ai.request.images.estimate": 4_611,
      "app.ai.request.images.unsized": 1,
    });
    expect(
      Object.keys(first).filter((key) =>
        key.startsWith("app.ai.request.images."),
      ),
    ).toEqual([]);
  });
});
