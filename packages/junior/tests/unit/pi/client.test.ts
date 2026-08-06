import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  calculateCost: vi.fn(() => ({
    input: 0.001,
    output: 0.002,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.003,
  })),
  completeSimple: vi.fn(),
  createGatewayProvider: vi.fn(() => ({
    chat: vi.fn((modelId: string) => ({ modelId })),
    embeddingModel: vi.fn((modelId: string) => ({ modelId })),
  })),
  embedMany: vi.fn(),
  generateObject: vi.fn(),
  getModels: vi.fn(() => [{ id: "openai/gpt-4o-mini" }]),
  logException: vi.fn(),
  logWarn: vi.fn(),
  noObjectGeneratedErrorIsInstance: vi.fn(),
  registerApiProvider: vi.fn(),
  resolveGatewayCredential: vi.fn(),
  setSpanAttributes: vi.fn(),
  streamAnthropic: vi.fn(),
  streamSimpleAnthropic: vi.fn(),
  withSpan: vi.fn(
    async (
      _name: string,
      _op: string,
      _context: Record<string, unknown>,
      callback: (
        setSpanAttributes: (attributes: Record<string, unknown>) => void,
      ) => Promise<unknown>,
      _attributes?: Record<string, unknown>,
    ) => callback(mocks.setSpanAttributes),
  ),
}));

vi.mock("@/chat/pi/sdk", () => ({
  calculateCost: mocks.calculateCost,
  completeSimple: mocks.completeSimple,
  getModels: mocks.getModels,
  registerApiProvider: mocks.registerApiProvider,
  streamAnthropic: mocks.streamAnthropic,
  streamSimpleAnthropic: mocks.streamSimpleAnthropic,
}));

vi.mock("@/chat/pi/gateway-auth", () => ({
  getGatewayApiKey: vi.fn(async () => {
    const credential = await mocks.resolveGatewayCredential();
    return credential?.token;
  }),
  getPiGatewayApiKey: vi.fn(async () => {
    const credential = await mocks.resolveGatewayCredential();
    return credential?.token;
  }),
  MISSING_GATEWAY_CREDENTIALS_ERROR:
    "Missing AI gateway credentials (enable Vercel OIDC or set AI_GATEWAY_API_KEY)",
  resolveGatewayCredential: mocks.resolveGatewayCredential,
}));

vi.mock("@ai-sdk/gateway", () => ({
  createGatewayProvider: mocks.createGatewayProvider,
}));

vi.mock("ai", () => ({
  embedMany: mocks.embedMany,
  generateObject: mocks.generateObject,
  NoObjectGeneratedError: {
    isInstance: mocks.noObjectGeneratedErrorIsInstance,
  },
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
    mocks.resolveGatewayCredential.mockResolvedValue({
      mode: "oidc",
      token: "oidc-token",
    });
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
      messageAttributeMode: "content",
    });

    expect(result.text).toBe("hello world");
    expect(mocks.withSpan).toHaveBeenCalledTimes(1);
    expect(mocks.completeSimple).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ apiKey: "oidc-token" }),
    );

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
        "gen_ai.request.reasoning.level": "low",
        "gen_ai.provider.auth_mode": "oidc",
      }),
    );
    expect(attributes["gen_ai.system_instructions"]).toBeDefined();
    expect(attributes["gen_ai.input.messages"]).toBeDefined();

    expect(mocks.setSpanAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "gen_ai.output.messages": expect.any(String),
        "gen_ai.response.finish_reasons": ["stop"],
      }),
    );
  });

  it("omits opt-in semantic content for non-public conversation traces", async () => {
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
      destinationName: "D1",
      modelId: "openai/gpt-4o-mini",
    });
    expect(attributes["app.conversation.privacy"]).toBe("private");
    expect(attributes["server.address"]).toBe("ai-gateway.vercel.sh");
    expect(attributes["server.port"]).toBe(443);
    expect(attributes["gen_ai.output.type"]).toBe("text");
    expect(attributes["gen_ai.input.message_count"]).toBe(1);
    expect(attributes["gen_ai.input.content_chars"]).toBe(16);
    expect(attributes["gen_ai.system_instructions"]).toBeUndefined();
    expect(attributes["gen_ai.input.messages"]).toBeUndefined();

    const endAttributes = mocks.setSpanAttributes.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(endAttributes["gen_ai.output.message_count"]).toBe(1);
    expect(endAttributes["gen_ai.output.content_chars"]).toBe(14);
    expect(endAttributes["gen_ai.output.messages"]).toBeUndefined();
  });

  it("scrubs C-prefixed channel traces unless the turn confirmed the channel public", async () => {
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: "text", text: "maybe private answer" }],
      stopReason: "stop",
      usage: { input: 12, output: 4, totalTokens: 16 },
    });

    const { completeText } = await import("@/chat/pi/client");
    const { runWithConversationPrivacy } =
      await import("@/chat/conversation-privacy");

    // Modern Slack private channels also use C ids: without a confirmed
    // signal the capture stays metadata-only.
    await completeText({
      modelId: "openai/gpt-4o-mini",
      messages: [
        { role: "user", content: "possibly private question", timestamp: 1 },
      ] as any,
      metadata: { conversationId: "slack:C1:123", channelId: "C1" },
    });
    const noSignal = mocks.withSpan.mock.calls[0]?.[4] as Record<
      string,
      unknown
    >;
    expect(noSignal["app.conversation.privacy"]).toBe("private");
    expect(noSignal["gen_ai.input.messages"]).toBeUndefined();

    // The turn-scoped privacy context carries the source-confirmed signal.
    await runWithConversationPrivacy("public", () =>
      completeText({
        modelId: "openai/gpt-4o-mini",
        messages: [
          { role: "user", content: "public question", timestamp: 1 },
        ] as any,
        metadata: { conversationId: "slack:C1:123", channelId: "C1" },
      }),
    );
    const publicSignal = mocks.withSpan.mock.calls[1]?.[4] as Record<
      string,
      unknown
    >;
    expect(publicSignal["app.conversation.privacy"]).toBe("public");
    expect(publicSignal["gen_ai.input.messages"]).toContain("public question");
  });

  it("uses AI SDK structured output for object completions", async () => {
    mocks.generateObject.mockResolvedValue({
      object: { ok: true },
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        inputTokenDetails: {
          noCacheTokens: 8,
          cacheReadTokens: 2,
          cacheWriteTokens: 0,
        },
        outputTokens: 3,
        outputTokenDetails: { textTokens: 3, reasoningTokens: 1 },
        totalTokens: 13,
      },
    });

    const { completeObject } = await import("@/chat/pi/client");
    const schema = z.object({ ok: z.boolean() });

    const result = await completeObject({
      modelId: "openai/gpt-4o-mini",
      schema,
      prompt: "return json",
      recordTelemetryPayloads: false,
      system: "structured only",
    });

    expect(result).toEqual({
      costUsd: 0.003,
      object: { ok: true },
    });
    expect(mocks.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { modelId: "openai/gpt-4o-mini" },
        schema,
        prompt: "return json",
        experimental_telemetry: {
          isEnabled: true,
          recordInputs: false,
          recordOutputs: false,
        },
        system: "structured only",
      }),
    );
    expect(mocks.setSpanAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "gen_ai.response.finish_reasons": ["stop"],
      }),
    );
  });

  it("keeps a successful object when cost estimation fails", async () => {
    mocks.generateObject.mockResolvedValue({
      object: { ok: true },
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        inputTokenDetails: {
          noCacheTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        outputTokens: 3,
        outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
        totalTokens: 13,
      },
    });
    mocks.calculateCost.mockImplementationOnce(() => {
      throw new Error("pricing unavailable");
    });

    const { completeObject } = await import("@/chat/pi/client");
    const result = await completeObject({
      modelId: "openai/gpt-4o-mini",
      schema: z.object({ ok: z.boolean() }),
      prompt: "return json",
    });

    expect(result).toEqual({ object: { ok: true } });
  });

  it("rethrows retryable object provider failures without capturing", async () => {
    mocks.generateObject.mockRejectedValue(
      new Error("Anthropic stream ended before message_stop"),
    );

    const { completeObject } = await import("@/chat/pi/client");

    await expect(
      completeObject({
        modelId: "openai/gpt-4o-mini",
        schema: z.object({ ok: z.boolean() }),
        prompt: "return json",
      }),
    ).rejects.toThrow("AI provider error: network");
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logException).not.toHaveBeenCalled();
  });

  it("classifies invalid structured output without capturing it", async () => {
    const sdkError = new Error("No object generated.");
    mocks.generateObject.mockRejectedValue(sdkError);
    mocks.noObjectGeneratedErrorIsInstance.mockReturnValueOnce(true);

    const { completeObject } = await import("@/chat/pi/client");

    await expect(
      completeObject({
        modelId: "anthropic/claude-haiku-4.5",
        schema: z.object({ ok: z.boolean() }),
        prompt: "return json",
      }),
    ).rejects.toMatchObject({
      cause: sdkError,
      kind: "invalid_response",
      message: "AI provider error: invalid_response",
      retryable: false,
    });
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logException).not.toHaveBeenCalled();
  });

  it("records embedding usage and dimensions on the embedding span", async () => {
    mocks.embedMany.mockResolvedValue({
      embeddings: [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ],
      usage: { tokens: 8 },
    });

    const { embedTexts } = await import("@/chat/pi/client");
    const result = await embedTexts({
      modelId: "openai/text-embedding-3-small",
      texts: ["one", "two"],
    });

    expect(result.dimensions).toBe(3);
    expect(result.costUsd).toBe(0.00000016);
    const startAttributes = mocks.withSpan.mock.calls[0]?.[4] as Record<
      string,
      unknown
    >;
    expect(startAttributes["gen_ai.operation.name"]).toBe("embeddings");
    expect(startAttributes["gen_ai.output.type"]).toBeUndefined();
    expect(mocks.setSpanAttributes).toHaveBeenCalledWith({
      "app.cost.input_usd": 0.00000016,
      "app.cost.total_usd": 0.00000016,
      "gen_ai.embeddings.dimension.count": 3,
      "gen_ai.usage.input_tokens": 8,
    });
  });

  it("leaves embedding cost unknown for models without a verified rate", async () => {
    mocks.embedMany.mockResolvedValue({
      embeddings: [[0.1, 0.2, 0.3]],
      usage: { tokens: 8 },
    });

    const { embedTexts } = await import("@/chat/pi/client");
    const result = await embedTexts({
      modelId: "example/unpriced-embedding-model",
      texts: ["one"],
    });

    expect(result).not.toHaveProperty("costUsd");
    expect(mocks.setSpanAttributes).toHaveBeenCalledWith({
      "gen_ai.embeddings.dimension.count": 3,
      "gen_ai.usage.input_tokens": 8,
    });
  });

  it("validates embedding output before the embedding span ends", async () => {
    mocks.embedMany.mockResolvedValue({
      embeddings: [[0.1], [0.2, 0.3]],
      usage: { tokens: 8 },
    });

    const { embedTexts } = await import("@/chat/pi/client");

    await expect(
      embedTexts({
        modelId: "openai/text-embedding-3-small",
        texts: ["one", "two"],
      }),
    ).rejects.toThrow("AI provider error: invalid_response");
    expect(mocks.setSpanAttributes).not.toHaveBeenCalled();
  });
});
