import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  getEnvApiKey: vi.fn(),
  getModels: vi.fn(() => [{ id: "openai/gpt-4o-mini" }]),
  logException: vi.fn(),
  logWarn: vi.fn(),
  registerApiProvider: vi.fn(),
  setSpanAttributes: vi.fn(),
  streamAnthropic: vi.fn(),
  streamSimpleAnthropic: vi.fn(),
  withSpan: vi.fn(
    async (
      _name: string,
      _op: string,
      _context: Record<string, unknown>,
      callback: () => Promise<unknown>,
      _attributes?: Record<string, unknown>,
    ) => callback(),
  ),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  completeSimple: mocks.completeSimple,
  getEnvApiKey: mocks.getEnvApiKey,
  getModels: mocks.getModels,
  registerApiProvider: mocks.registerApiProvider,
}));

vi.mock("@earendil-works/pi-ai/anthropic", () => ({
  streamAnthropic: mocks.streamAnthropic,
  streamSimpleAnthropic: mocks.streamSimpleAnthropic,
}));

vi.mock("@/chat/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/logging")>()),
  logException: mocks.logException,
  logWarn: mocks.logWarn,
  setSpanAttributes: mocks.setSpanAttributes,
  withSpan: mocks.withSpan,
}));

describe("completeText", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("creates a gen_ai.chat span for provider completions", async () => {
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: "text", text: "hello world" }],
      stopReason: "stop",
      usage: {
        input: 12,
        output: 4,
        totalTokens: 16,
      },
    });

    const { completeText, GEN_AI_PROVIDER_NAME } =
      await import("@/chat/pi/client");

    const result = await completeText({
      modelId: "openai/gpt-4o-mini",
      system: "Be concise.",
      messages: [{ role: "user", content: "hi", timestamp: 1 }] as any,
      thinkingLevel: "low",
    });

    expect(result.text).toBe("hello world");
    expect(mocks.withSpan).toHaveBeenCalledTimes(1);

    const [name, op, context, _callback, attributes] = mocks.withSpan.mock
      .calls[0] as [
      string,
      string,
      Record<string, unknown>,
      () => Promise<unknown>,
      Record<string, unknown>,
    ];

    expect(name).toBe("chat openai/gpt-4o-mini");
    expect(op).toBe("gen_ai.chat");
    expect(context).toEqual({ modelId: "openai/gpt-4o-mini" });
    expect(attributes).toEqual(
      expect.objectContaining({
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "openai/gpt-4o-mini",
        "gen_ai.output.type": "text",
        "server.address": "ai-gateway.vercel.sh",
        "server.port": 443,
        "app.ai.reasoning_effort": "low",
      }),
    );
    expect(attributes["gen_ai.system_instructions"]).toBeDefined();
    expect(attributes["gen_ai.input.messages"]).toBeDefined();

    expect(mocks.setSpanAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "openai/gpt-4o-mini",
        "gen_ai.output.type": "text",
        "server.address": "ai-gateway.vercel.sh",
        "server.port": 443,
        "gen_ai.output.messages": expect.any(String),
        "gen_ai.response.finish_reasons": ["stop"],
      }),
    );
  });

  it("uses message metadata for non-public conversation traces", async () => {
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: "text", text: "private answer" }],
      stopReason: "stop",
      usage: { input: 12, output: 4, totalTokens: 16 },
    });

    const { completeText } = await import("@/chat/pi/client");

    await completeText({
      modelId: "openai/gpt-4o-mini",
      system: "private system",
      messages: [
        { role: "user", content: "private question", timestamp: 1 },
      ] as any,
      metadata: {
        conversationId: "slack:D1:123",
        channelId: "D1",
      },
    });

    const attributes = mocks.withSpan.mock.calls[0]?.[4] as Record<
      string,
      unknown
    >;
    const context = mocks.withSpan.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(context).toMatchObject({
      conversationId: "slack:D1:123",
      slackChannelId: "D1",
      modelId: "openai/gpt-4o-mini",
    });
    expect(attributes["app.conversation.privacy"]).toBe("private");
    expect(attributes["server.address"]).toBe("ai-gateway.vercel.sh");
    expect(attributes["server.port"]).toBe(443);
    expect(attributes["gen_ai.output.type"]).toBe("text");
    expect(attributes["app.ai.input.message_count"]).toBe(1);
    expect(attributes["app.ai.input.content_chars"]).toBe(16);
    expect(attributes["gen_ai.system_instructions"]).toContain('"chars"');
    expect(attributes["gen_ai.system_instructions"]).not.toContain(
      "private system",
    );
    expect(attributes["gen_ai.input.messages"]).toContain('"chars"');
    expect(attributes["gen_ai.input.messages"]).not.toContain(
      "private question",
    );

    const endAttributes = mocks.setSpanAttributes.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(endAttributes["app.ai.output.message_count"]).toBe(1);
    expect(endAttributes["app.ai.output.content_chars"]).toBe(14);
    expect(endAttributes["gen_ai.output.messages"]).toContain('"chars"');
    expect(endAttributes["gen_ai.output.messages"]).not.toContain(
      "private answer",
    );
  });
});
