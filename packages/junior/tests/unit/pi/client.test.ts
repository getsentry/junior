import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as z from "zod";

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
    rerankingModel: vi.fn((modelId: string) => ({ modelId })),
    transcriptionModel: vi.fn((modelId: string) => ({ modelId })),
  })),
  embedMany: vi.fn(),
  generateObject: vi.fn(),
  getModels: vi.fn((): Array<{ id: string; maxTokens?: number }> => [
    { id: "openai/gpt-4o-mini" },
  ]),
  logException: vi.fn(),
  logWarn: vi.fn(),
  noObjectGeneratedErrorIsInstance: vi.fn(),
  registerApiProvider: vi.fn(),
  rerank: vi.fn(),
  resolveGatewayCredential: vi.fn(),
  setSpanAttributes: vi.fn(),
  streamAnthropic: vi.fn(),
  streamSimpleAnthropic: vi.fn(),
  transcribe: vi.fn(),
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
  rerank: mocks.rerank,
  transcribe: mocks.transcribe,
}));

vi.mock("@/chat/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/logging")>()),
  logException: mocks.logException,
  logWarn: mocks.logWarn,
  setSpanAttributes: mocks.setSpanAttributes,
  withSpan: mocks.withSpan,
}));

describe("resolveGatewayModel", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it.each([
    ["openai/gpt-6-astra", 1_050_000],
    ["openai/gpt-6-luna", 1_050_000],
    ["anthropic/claude-opus-5.5", 1_000_000],
  ] as const)(
    "loads %s before pi-ai publishes it",
    async (modelId, contextWindow) => {
      const { resolveGatewayModel } = await import("@/chat/pi/client");

      expect(resolveGatewayModel(modelId)).toEqual(
        expect.objectContaining({
          id: modelId,
          provider: "vercel-ai-gateway",
          contextWindow,
          maxTokens: 128_000,
        }),
      );
    },
  );
});

describe("completeText", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("sends the request through Pi and returns its text", async () => {
    mocks.resolveGatewayCredential.mockResolvedValue({
      mode: "oidc",
      token: "oidc-token",
    });
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: "text", text: "hello world" }],
      stopReason: "stop",
      responseId: "gen_123",
      usage: { input: 12, output: 4, totalTokens: 16 },
    });

    const { completeText } = await import("@/chat/pi/client");

    const result = await completeText({
      modelId: "openai/gpt-4o-mini",
      system: "Be concise.",
      messages: [{ role: "user", content: "hi", timestamp: 1 }] as any,
      thinkingLevel: "low",
      cacheRetention: "none",
      sessionId: "slack:C123:1700000000.000",
    });

    expect(result.text).toBe("hello world");
    expect(mocks.completeSimple).toHaveBeenCalledWith(
      expect.objectContaining({ id: "openai/gpt-4o-mini" }),
      expect.objectContaining({ systemPrompt: "Be concise." }),
      expect.objectContaining({
        apiKey: "oidc-token",
        cacheRetention: "none",
        reasoning: "low",
        sessionId: "slack:C123:1700000000.000",
      }),
    );
  });

  it("throws a provider error for an error stop", async () => {
    mocks.resolveGatewayCredential.mockResolvedValue({
      mode: "oidc",
      token: "oidc-token",
    });
    mocks.completeSimple.mockResolvedValue({
      content: [],
      stopReason: "error",
      errorMessage: "upstream exploded",
      usage: { input: 0, output: 0, totalTokens: 0 },
    });

    const { completeText } = await import("@/chat/pi/client");

    await expect(
      completeText({
        modelId: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hi", timestamp: 1 }] as any,
      }),
    ).rejects.toThrow("AI provider error");
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "ai.completion.provider_error",
      expect.objectContaining({ "exception.message": "upstream exploded" }),
    );
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

  it("classifies invalid structured output without capturing it or its text", async () => {
    const sdkError = Object.assign(
      new Error("No object generated: could not parse the response.", {
        cause: new Error("JSON parsing failed: Text: model output"),
      }),
      { name: "AI_NoObjectGeneratedError", text: "model output" },
    );
    mocks.generateObject.mockRejectedValue(sdkError);
    // The span records usage first, then the error is classified.
    mocks.noObjectGeneratedErrorIsInstance
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);

    const { completeObject } = await import("@/chat/pi/client");

    await expect(
      completeObject({
        modelId: "anthropic/claude-haiku-4.5",
        schema: z.object({ ok: z.boolean() }),
        prompt: "return json",
      }),
    ).rejects.toSatisfy((error: Error) => {
      expect(error).toMatchObject({
        kind: "invalid_response",
        message: "AI provider error: invalid_response",
        retryable: false,
      });
      expect(error.cause).toMatchObject({
        name: "AI_NoObjectGeneratedError",
        message: "No object generated: could not parse the response.",
      });
      expect(
        JSON.stringify(error.cause, Object.getOwnPropertyNames(error.cause)),
      ).not.toContain("model output");
      return true;
    });
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logException).not.toHaveBeenCalled();
  });

  it("adds reasoning room to the object budget and reports a spent budget", async () => {
    const ai = await vi.importActual<typeof import("ai")>("ai");
    const { MockLanguageModelV4 } = await import("ai/test");
    // Reasoning used most of the budget, so the JSON stops partway through.
    const model = new MockLanguageModelV4({
      modelId: "openai/gpt-6-luna",
      doGenerate: {
        content: [{ type: "text", text: '{"ok": tr' }],
        finishReason: { unified: "length", raw: "max_output_tokens" },
        usage: {
          inputTokens: {
            total: 100,
            noCache: 100,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: { total: 8_500, text: 5, reasoning: 8_495 },
        },
        warnings: [],
      },
    });
    mocks.createGatewayProvider.mockReturnValueOnce({
      chat: vi.fn(() => model),
      embeddingModel: vi.fn((modelId: string) => ({ modelId })),
      rerankingModel: vi.fn((modelId: string) => ({ modelId })),
      transcriptionModel: vi.fn((modelId: string) => ({ modelId })),
    });
    mocks.generateObject.mockImplementationOnce(ai.generateObject);
    mocks.noObjectGeneratedErrorIsInstance.mockImplementation(
      ai.NoObjectGeneratedError.isInstance,
    );
    onTestFinished(() => {
      mocks.noObjectGeneratedErrorIsInstance.mockReset();
    });

    const { completeObject } = await import("@/chat/pi/client");

    await expect(
      completeObject({
        modelId: "openai/gpt-6-luna",
        schema: z.object({ ok: z.boolean() }),
        prompt: "return json",
        maxTokens: 2_500,
      }),
    ).rejects.toSatisfy((error: Error) => {
      expect(error).toMatchObject({ kind: "invalid_response" });
      expect(error.cause).toMatchObject({
        name: "StructuredOutputLengthError",
        message: "Structured output hit the output token limit",
      });
      expect(
        JSON.stringify(error.cause, Object.getOwnPropertyNames(error.cause)),
      ).not.toContain('{"ok": tr');
      return true;
    });
    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(8_500);
    expect(mocks.setSpanAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "gen_ai.response.finish_reasons": ["length"],
        "gen_ai.usage.output_tokens": 8_500,
        "gen_ai.usage.reasoning.output_tokens": 8_495,
      }),
    );
  });

  it.each([
    [
      "clamps to the output limit of a catalog model",
      "mistral/mistral-small",
      4_000,
    ],
    [
      "keeps the full limit for a model outside the catalog",
      "plugin/custom",
      8_500,
    ],
  ] as const)("%s", async (_name, modelId, maxOutputTokens) => {
    mocks.getModels.mockReturnValueOnce([
      { id: "mistral/mistral-small", maxTokens: 4_000 },
    ]);
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

    const { completeObject } = await import("@/chat/pi/client");
    await completeObject({
      modelId,
      schema: z.object({ ok: z.boolean() }),
      prompt: "return json",
      maxTokens: 2_500,
    });

    expect(mocks.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens }),
    );
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

  it("sends the input type only to models that embed queries differently", async () => {
    mocks.embedMany.mockResolvedValue({
      embeddings: [[0.1, 0.2, 0.3]],
      usage: { tokens: 8 },
    });

    const { embedTexts } = await import("@/chat/pi/client");
    await embedTexts({
      inputType: "query",
      modelId: "voyage/voyage-4-lite",
      texts: ["one"],
    });
    await embedTexts({
      inputType: "query",
      modelId: "openai/text-embedding-3-small",
      texts: ["one"],
    });

    expect(mocks.embedMany.mock.calls[0]?.[0]).toMatchObject({
      providerOptions: { voyage: { inputType: "query" } },
    });
    expect(mocks.embedMany.mock.calls[1]?.[0]).not.toHaveProperty(
      "providerOptions",
    );
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

  it("returns rerank scores in input order with the gateway cost", async () => {
    // The SDK sorts by score and AI Gateway reports cost as a decimal string.
    mocks.rerank.mockResolvedValue({
      providerMetadata: { gateway: { cost: "0.0000074" } },
      ranking: [
        { originalIndex: 1, score: 0.9 },
        { originalIndex: 0, score: 0.2 },
      ],
    });

    const { rerankTexts } = await import("@/chat/pi/client");
    const result = await rerankTexts({
      documents: ["one", "two"],
      modelId: "voyage/rerank-2.5-lite",
      query: "which one",
    });

    expect(result).toEqual({ costUsd: 0.0000074, scores: [0.2, 0.9] });
    expect(mocks.setSpanAttributes).toHaveBeenCalledWith({
      "app.cost.total_usd": 0.0000074,
    });
  });
});

describe("transcribeFromUrl", () => {
  const SIGNED_URL = "https://blob.example.test/a.m4a?signature=secret";

  afterEach(() => {
    vi.clearAllMocks();
  });

  /** Every span attribute and log that the call recorded. */
  function recordedTelemetry(): string {
    return JSON.stringify([
      mocks.withSpan.mock.calls.map((call) => [call[0], call[2], call[4]]),
      mocks.setSpanAttributes.mock.calls,
      mocks.logException.mock.calls,
    ]);
  }

  it("records model, audio length, cost, and generation id on the span", async () => {
    mocks.resolveGatewayCredential.mockResolvedValue({
      mode: "api_key",
      token: "gateway-key",
    });
    mocks.transcribe.mockResolvedValue({
      durationInSeconds: 30,
      language: "eng",
      providerMetadata: {
        gateway: { cost: "0.00183336", generationId: "gen_1" },
      },
      segments: [{ endSecond: 0.7, startSecond: 0.1, text: "Hello" }],
      text: "Hello",
    });

    const { transcribeFromUrl } = await import("@/chat/pi/transcription");
    const result = await transcribeFromUrl({
      modelId: "elevenlabs/scribe-v2",
      sourceUrl: SIGNED_URL,
    });

    expect(result).toEqual({
      costUsd: 0.00183336,
      durationSeconds: 30,
      entries: [{ kind: "speech", startSeconds: 0.1, text: "Hello" }],
      language: "eng",
    });
    expect(mocks.transcribe.mock.calls[0]?.[0]).toMatchObject({
      audio: new Uint8Array(),
      providerOptions: { elevenlabs: { diarize: true, sourceUrl: SIGNED_URL } },
    });
    expect(mocks.withSpan.mock.calls[0]?.[1]).toBe("gen_ai.transcription");
    expect(mocks.withSpan.mock.calls[0]?.[4]).toMatchObject({
      "gen_ai.operation.name": "transcription",
      "gen_ai.request.model": "elevenlabs/scribe-v2",
    });
    expect(mocks.setSpanAttributes).toHaveBeenCalledWith({
      "app.cost.total_usd": 0.00183336,
      "app.transcription.audio_seconds": 30,
      "app.transcription.entry_count": 1,
      "gen_ai.response.id": "gen_1",
    });
    expect(recordedTelemetry()).not.toContain(SIGNED_URL);
    expect(recordedTelemetry()).not.toContain("Hello");
  });

  it("marks a file with no audio on the span without capturing it", async () => {
    mocks.resolveGatewayCredential.mockResolvedValue({
      mode: "api_key",
      token: "gateway-key",
    });
    mocks.transcribe.mockRejectedValue(
      new Error(
        "File is corrupted. Please ensure it is playable audio. (invalid_audio)",
      ),
    );

    const { NoAudioError, transcribeFromUrl } =
      await import("@/chat/pi/transcription");

    await expect(
      transcribeFromUrl({
        modelId: "elevenlabs/scribe-v2",
        sourceUrl: SIGNED_URL,
      }),
    ).rejects.toBeInstanceOf(NoAudioError);
    expect(mocks.setSpanAttributes).toHaveBeenCalledWith({
      "error.type": "invalid_audio",
    });
    expect(mocks.logException).not.toHaveBeenCalled();
  });
});
