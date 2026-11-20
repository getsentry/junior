import {
  calculateCost,
  completeSimple,
  getModels,
  registerApiProvider,
  streamAnthropic,
  streamSimpleAnthropic,
  type CacheRetention,
  type Api,
  type Message,
  type Model,
  type ThinkingLevel,
  type Tool,
} from "@/chat/pi/sdk";
import { createGatewayProvider } from "@ai-sdk/gateway";
import {
  getGatewayApiKey,
  resolveGatewayCredential,
} from "@/chat/pi/gateway-auth";

export {
  getGatewayApiKey,
  resolveGatewayCredential,
  type GatewayCredential,
} from "@/chat/pi/gateway-auth";
import {
  embedMany,
  experimental_decide,
  Experimental_DecisionRefusalError,
  generateImage,
  generateText,
  NoImageGeneratedError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  rerank,
  type EmbedEndEvent,
  type GeneratedFile,
  type Experimental_DecideEndEvent,
  type Experimental_DecisionQuestion,
  type Experimental_DecisionResult,
  type Experimental_DecisionState,
  type LanguageModelUsage,
} from "ai";

// Directly register the anthropic provider at import time. pi-ai's built-in
// registration relies on opaque dynamic import() calls that break under
// Nitro's rolldown bundler (the lazy import paths resolve relative to the
// bundled chunk, not the original module).
registerApiProvider({
  api: "anthropic-messages",
  stream: withEnabledGatewayProviders(streamAnthropic),
  streamSimple: withChatSpanAttributes(
    withEnabledGatewayProviders(streamSimpleAnthropic),
  ),
});
import type * as z from "zod";
import type { ZodTypeAny } from "zod";
import {
  structuredOutputErrorCause,
  structuredOutputLengthError,
  structuredOutputTokenLimit,
} from "@/chat/pi/object-completion";
import {
  extractGenAiUsageAttributes,
  logException,
  logWarn,
  setSpanAttributes,
  withLogContext,
  type LogContext,
} from "@/chat/logging";
import {
  createProviderError,
  isProviderRetryError,
} from "@/chat/services/provider-error";
import {
  withChatRequestTelemetry,
  withChatSpanAttributes,
} from "@/chat/pi/chat-span";
import { withEnabledGatewayProviders } from "@/chat/gateway-providers/routing";

const GATEWAY_PROVIDER = "vercel-ai-gateway" as const;
const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
// Pi's bundled catalog can lag behind the gateway. Keep missing models and
// metadata corrections here until the catalog includes them. Remove these
// overrides when Pi supplies the same metadata or Junior uses a live catalog.
const GATEWAY_MODEL_OVERRIDES: Readonly<Record<string, Model<Api>>> = {
  // Metadata from https://ai-gateway.vercel.sh/v1/models.
  "anthropic/claude-opus-5.5": {
    id: "anthropic/claude-opus-5.5",
    name: "Claude Opus 5.5",
    api: "anthropic-messages",
    provider: GATEWAY_PROVIDER,
    baseUrl: GATEWAY_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite: 5,
    },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinkingLevelMap: {
      xhigh: "xhigh",
      max: "max",
    },
    compat: {
      forceAdaptiveThinking: true,
      supportsMidConvoSystemMessages: true,
      supportsTemperature: false,
    },
  },
  "xai/grok-4.5": {
    id: "xai/grok-4.5",
    name: "Grok 4.5",
    api: "anthropic-messages",
    provider: GATEWAY_PROVIDER,
    baseUrl: GATEWAY_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: 0.3,
      cacheWrite: 0,
    },
    contextWindow: 500_000,
    maxTokens: 500_000,
  },
  // Metadata from https://ai-gateway.vercel.sh/v1/models.
  "openai/gpt-6-luna": {
    id: "openai/gpt-6-luna",
    name: "GPT-6 Luna",
    api: "anthropic-messages",
    provider: GATEWAY_PROVIDER,
    baseUrl: GATEWAY_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      tiers: [
        {
          inputTokensAbove: 272_000,
          input: 0.2,
          output: 0.75,
          cacheRead: 0.02,
          cacheWrite: 0.25,
        },
      ],
    },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    thinkingLevelMap: {
      xhigh: "xhigh",
      max: "max",
    },
    compat: {
      supportsMidConvoSystemMessages: true,
    },
  },
  "openai/gpt-6-astra": {
    id: "openai/gpt-6-astra",
    name: "GPT-6 Astra",
    api: "anthropic-messages",
    provider: GATEWAY_PROVIDER,
    baseUrl: GATEWAY_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
      tiers: [
        {
          inputTokensAbove: 272_000,
          input: 20,
          output: 75,
          cacheRead: 2,
          cacheWrite: 25,
        },
      ],
    },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    thinkingLevelMap: {
      xhigh: "xhigh",
      max: "max",
    },
    compat: {
      supportsTemperature: false,
    },
  },
};
export const GEN_AI_PROVIDER_NAME = GATEWAY_PROVIDER;
export const GEN_AI_SERVER_ADDRESS = "ai-gateway.vercel.sh";
export const GEN_AI_SERVER_PORT = 443;
const GEN_AI_OPERATION_CHAT = "chat" as const;
const GEN_AI_OPERATION_EMBEDDINGS = "embeddings" as const;
const GEN_AI_OPERATION_RERANK = "rerank" as const;
// AI Gateway input rates in USD per million tokens. Keep estimates
// model-specific so unlisted configured models remain explicitly unknown.
const EMBEDDING_INPUT_COST_USD_PER_MILLION_TOKENS: Readonly<
  Record<string, number>
> = {
  "cohere/embed-v4.0": 0.12,
  "google/gemini-embedding-001": 0.15,
  "google/text-embedding-005": 0.025,
  "mistral/mistral-embed": 0.1,
  "openai/text-embedding-3-large": 0.13,
  "openai/text-embedding-3-small": 0.02,
  "openai/text-embedding-ada-002": 0.1,
  "voyage/voyage-3.5": 0.06,
  "voyage/voyage-3.5-lite": 0.02,
  "voyage/voyage-4": 0.06,
  "voyage/voyage-4-large": 0.12,
  "voyage/voyage-4-lite": 0.02,
};
// Decision models bill input tokens only.
const DECISION_INPUT_COST_USD_PER_MILLION_TOKENS: Readonly<
  Record<string, number>
> = {
  "openai/gpt-6-luna-decisions": 0.1,
  "typesafe-ai/jev": 0.042,
};

function decisionCostUsd(
  modelId: string,
  inputTokens: number | undefined,
): number | undefined {
  const costPerMillionTokens =
    DECISION_INPUT_COST_USD_PER_MILLION_TOKENS[modelId];
  return costPerMillionTokens === undefined || inputTokens === undefined
    ? undefined
    : (inputTokens * costPerMillionTokens) / 1_000_000;
}

function embeddingCostUsd(
  modelId: string,
  inputTokens: number,
): number | undefined {
  const costPerMillionTokens =
    EMBEDDING_INPUT_COST_USD_PER_MILLION_TOKENS[modelId];
  return costPerMillionTokens === undefined
    ? undefined
    : (inputTokens * costPerMillionTokens) / 1_000_000;
}

function inputCostAttributes(costUsd: number | undefined) {
  return extractGenAiUsageAttributes({
    cost: { input: costUsd, total: costUsd },
  });
}

/**
 * `ai` runs `onStart` and `onEnd` inside the span that the SDK's
 * `vercelAIIntegration` starts for the call. Spans are sent when they end, so
 * call attributes must be set here, not after the call returns.
 */
function aiSdkSpanCallbacks<TEndEvent>(
  attributes: Record<string, unknown>,
  endAttributes?: (event: TEndEvent) => Record<string, unknown>,
) {
  return {
    onStart: () => setSpanAttributes(attributes),
    ...(endAttributes
      ? {
          onEnd: (event: TEndEvent) => setSpanAttributes(endAttributes(event)),
        }
      : undefined),
  };
}

function extractText(message: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  return (message.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

function findGatewayModel(modelId: string): Model<Api> | undefined {
  return (
    GATEWAY_MODEL_OVERRIDES[modelId] ??
    getModels(GATEWAY_PROVIDER).find(
      (model: Model<Api>) => model.id === modelId,
    )
  );
}

/** Resolve gateway models through local overrides, then Pi's bundled catalog. */
export function resolveGatewayModel(modelId: string): Model<Api> {
  const matched = findGatewayModel(modelId);
  if (!matched) {
    throw new Error(`Unknown AI Gateway model id: ${modelId}`);
  }
  // AI Gateway groups requests into a session by `x-session-affinity`. Pi
  // sends it only for calls that pass a `sessionId`.
  return {
    ...matched,
    compat: { ...matched.compat, sendSessionAffinityHeaders: true },
  };
}

/**
 * Execute a direct chat completion. The SDK's `piAiIntegration` records its
 * `gen_ai.chat` span.
 */
export async function completeText(params: {
  modelId: string;
  system?: string | undefined;
  messages: Message[];
  /** Tool definitions to send. They are part of the cached prompt prefix. */
  tools?: Tool[];
  cacheRetention?: CacheRetention;
  thinkingLevel?: ThinkingLevel;
  maxTokens?: number;
  signal?: AbortSignal | undefined;
  metadata?: Record<string, unknown>;
  promptName?: string;
  /** AI Gateway session ID. Pass the Conversation ID to share its session. */
  sessionId?: string;
}) {
  const model = resolveGatewayModel(params.modelId);
  const credential = await resolveGatewayCredential();
  let message: Awaited<ReturnType<typeof completeSimple>>;
  try {
    message = await withLogContext(
      logContextFromMetadata(params.modelId, params.metadata),
      () =>
        withChatRequestTelemetry(
          {
            attributes: {
              "gen_ai.prompt.name": params.promptName,
              "gen_ai.provider.auth_mode": credential.mode,
            },
          },
          () =>
            completeSimple(
              model,
              {
                systemPrompt: params.system,
                messages: params.messages,
                ...(params.tools ? { tools: params.tools } : undefined),
              },
              {
                apiKey: credential.token,
                maxTokens: params.maxTokens,
                reasoning: params.thinkingLevel,
                cacheRetention: params.cacheRetention,
                signal: params.signal,
                metadata: params.metadata,
                sessionId: params.sessionId,
              },
            ),
        ),
    );
  } catch (error) {
    throw createProviderError(error, { modelId: params.modelId });
  }
  if (message.stopReason === "error") {
    const providerMessage =
      message.errorMessage?.trim() || "Unknown provider error";
    logWarn("ai.completion.provider_error", {
      "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
      "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
      "gen_ai.request.model": params.modelId,
      "gen_ai.prompt.name": params.promptName,
      "exception.message": providerMessage,
    });
    throw createProviderError(providerMessage, { modelId: params.modelId });
  }

  return {
    message,
    text: extractText(message),
  };
}

function logContextFromMetadata(
  modelId: string,
  metadata: Record<string, unknown> | undefined,
): LogContext {
  const conversationId =
    typeof metadata?.["conversationId"] === "string" &&
    metadata["conversationId"]
      ? metadata["conversationId"]
      : undefined;
  const messageConversationId =
    typeof metadata?.["threadId"] === "string"
      ? metadata["threadId"]
      : undefined;
  const destinationName =
    typeof metadata?.["channelId"] === "string"
      ? metadata["channelId"]
      : undefined;
  const runId =
    typeof metadata?.["runId"] === "string" ? metadata["runId"] : undefined;

  return {
    modelId,
    ...(conversationId ? { conversationId } : undefined),
    ...(messageConversationId ? { messageConversationId } : undefined),
    ...(destinationName ? { destinationName } : undefined),
    ...(runId ? { runId } : undefined),
  };
}

function objectCompletionCost(
  modelId: string,
  usage: LanguageModelUsage,
): number | undefined {
  const cacheRead = usage.inputTokenDetails.cacheReadTokens;
  const cacheWrite = usage.inputTokenDetails.cacheWriteTokens;
  const input =
    usage.inputTokenDetails.noCacheTokens ??
    (usage.inputTokens === undefined
      ? undefined
      : Math.max(0, usage.inputTokens - (cacheRead ?? 0) - (cacheWrite ?? 0)));
  if (
    input === undefined &&
    usage.outputTokens === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }

  return calculateCost(resolveGatewayModel(modelId), {
    input: input ?? 0,
    output: usage.outputTokens ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    ...(usage.outputTokenDetails.reasoningTokens !== undefined
      ? { reasoning: usage.outputTokenDetails.reasoningTokens }
      : undefined),
    totalTokens:
      usage.totalTokens ??
      (input ?? 0) +
        (usage.outputTokens ?? 0) +
        (cacheRead ?? 0) +
        (cacheWrite ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }).total;
}

/** Estimate cost without changing the outcome of a successful completion. */
function bestEffortObjectCompletionCost(
  modelId: string,
  usage: LanguageModelUsage,
): number | undefined {
  try {
    return objectCompletionCost(modelId, usage);
  } catch (error) {
    logWarn("ai.completion.cost_estimate.failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
      "gen_ai.request.model": modelId,
    });
    return undefined;
  }
}

/** Execute a schema-constrained completion using the AI SDK structured output path. */
export async function completeObject<TSchema extends ZodTypeAny>(params: {
  modelId: string;
  schema: TSchema;
  system?: string;
  prompt: string;
  thinkingLevel?: ThinkingLevel;
  /** Tokens for the object itself. Reasoning gets its own room on top. */
  maxTokens?: number;
  signal?: AbortSignal | undefined;
  metadata?: Record<string, unknown>;
  promptName?: string;
}): Promise<{ costUsd?: number; object: z.infer<TSchema> }> {
  // Plugins can name a model outside the catalog, so a miss sends the sum.
  const maxOutputTokens = structuredOutputTokenLimit(
    params.maxTokens,
    findGatewayModel(params.modelId)?.maxTokens,
  );
  const credential = await resolveGatewayCredential();
  const provider = createGatewayProvider({ apiKey: credential.token });
  try {
    const result = await withLogContext(
      logContextFromMetadata(params.modelId, params.metadata),
      () =>
        generateText({
          model: provider.chat(params.modelId),
          output: Output.object({ schema: params.schema }),
          prompt: params.prompt,
          ...(params.system !== undefined
            ? { system: params.system }
            : undefined),
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : undefined),
          ...(params.signal !== undefined
            ? { abortSignal: params.signal }
            : undefined),
          ...(params.promptName
            ? { telemetry: { functionId: params.promptName } }
            : undefined),
          ...aiSdkSpanCallbacks({
            ...(params.promptName
              ? { "gen_ai.prompt.name": params.promptName }
              : undefined),
            "gen_ai.provider.auth_mode": credential.mode,
            ...(params.thinkingLevel
              ? { "gen_ai.request.reasoning.level": params.thinkingLevel }
              : undefined),
            ...(maxOutputTokens !== undefined
              ? { "gen_ai.request.max_tokens": maxOutputTokens }
              : undefined),
          }),
        }),
    );
    // When the budget runs out before any text, the SDK parses no output and
    // `result.output` throws a NoOutputGeneratedError without the finish
    // reason. Report it as a spent budget, like a truncated object.
    if (result.finishReason === "length" && result.text.length === 0) {
      throw createProviderError(structuredOutputLengthError(), {
        kind: "invalid_response",
        modelId: params.modelId,
      });
    }
    const object = result.output as z.infer<TSchema>;
    const costUsd = bestEffortObjectCompletionCost(
      params.modelId,
      result.usage,
    );
    return {
      object,
      ...(costUsd !== undefined ? { costUsd } : undefined),
    };
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      throw createProviderError(structuredOutputErrorCause(error), {
        kind: "invalid_response",
        modelId: params.modelId,
      });
    }
    if (NoOutputGeneratedError.isInstance(error)) {
      throw createProviderError(error, {
        kind: "invalid_response",
        modelId: params.modelId,
      });
    }
    throw createProviderError(error, { modelId: params.modelId });
  }
}

/** Answer typed decision questions with an AI Gateway decision model, such as Jev. */
export async function completeDecision<
  const TQuestions extends Record<string, Experimental_DecisionQuestion>,
>(params: {
  modelId: string;
  state: Experimental_DecisionState;
  questions: TQuestions;
  signal?: AbortSignal | undefined;
  metadata?: Record<string, unknown>;
  promptName?: string;
}): Promise<{
  answers: Experimental_DecisionResult<TQuestions>["answers"];
  costUsd?: number;
}> {
  const credential = await resolveGatewayCredential();
  const provider = createGatewayProvider({ apiKey: credential.token });
  try {
    const result = await withLogContext(
      logContextFromMetadata(params.modelId, params.metadata),
      () =>
        experimental_decide({
          model: provider.decisionModel(params.modelId),
          state: params.state,
          questions: params.questions,
          ...(params.signal !== undefined
            ? { abortSignal: params.signal }
            : undefined),
          ...aiSdkSpanCallbacks(
            {
              ...(params.promptName
                ? { "gen_ai.prompt.name": params.promptName }
                : undefined),
              "gen_ai.provider.auth_mode": credential.mode,
            },
            (event: Experimental_DecideEndEvent) =>
              inputCostAttributes(
                decisionCostUsd(params.modelId, event.usage.inputTokens),
              ),
          ),
        }),
    );
    const costUsd = decisionCostUsd(params.modelId, result.usage.inputTokens);
    return {
      answers: result.answers,
      ...(costUsd !== undefined ? { costUsd } : undefined),
    };
  } catch (error) {
    throw createProviderError(error, {
      ...(Experimental_DecisionRefusalError.isInstance(error)
        ? { kind: "invalid_response" }
        : undefined),
      modelId: params.modelId,
    });
  }
}

/** Map the input type to the provider option for models that embed queries and documents differently. */
function embeddingProviderOptions(
  modelId: string,
  inputType: "document" | "query" | undefined,
): { voyage: { inputType: "document" | "query" } } | undefined {
  if (inputType === undefined || !modelId.startsWith("voyage/")) {
    return undefined;
  }
  return { voyage: { inputType } };
}

/** Generate text embeddings through the host-owned AI Gateway provider. */
export async function embedTexts(params: {
  inputType?: "document" | "query";
  modelId: string;
  texts: string[];
  signal?: AbortSignal | undefined;
  metadata?: Record<string, unknown>;
}): Promise<{
  costUsd?: number;
  dimensions: number;
  model: string;
  provider: string;
  vectors: number[][];
}> {
  const texts = params.texts.map((text) => text.trim());
  if (texts.length === 0 || texts.some((text) => text.length === 0)) {
    throw new Error("Embedding text is required.");
  }
  const credential = await resolveGatewayCredential();
  const provider = createGatewayProvider({ apiKey: credential.token });
  const providerOptions = embeddingProviderOptions(
    params.modelId,
    params.inputType,
  );
  try {
    const result = await withLogContext(
      logContextFromMetadata(params.modelId, params.metadata),
      () =>
        embedMany({
          model: provider.embeddingModel(params.modelId),
          values: texts,
          ...(providerOptions !== undefined ? { providerOptions } : undefined),
          ...(params.signal !== undefined
            ? { abortSignal: params.signal }
            : undefined),
          ...aiSdkSpanCallbacks(
            { "gen_ai.provider.auth_mode": credential.mode },
            (event: EmbedEndEvent) => {
              const first = event.embedding[0];
              return {
                ...(Array.isArray(first)
                  ? { "gen_ai.embeddings.dimension.count": first.length }
                  : undefined),
                ...inputCostAttributes(
                  embeddingCostUsd(params.modelId, event.usage.tokens),
                ),
              };
            },
          ),
        }),
    );
    const dimensions = result.embeddings[0]?.length;
    if (
      result.embeddings.length !== texts.length ||
      !dimensions ||
      !result.embeddings.every((embedding) => embedding.length === dimensions)
    ) {
      throw createProviderError(
        "Embedding provider returned invalid vectors.",
        {
          kind: "invalid_response",
          modelId: params.modelId,
        },
      );
    }
    const costUsd = embeddingCostUsd(params.modelId, result.usage.tokens);
    return {
      ...(costUsd !== undefined ? { costUsd } : undefined),
      dimensions,
      model: params.modelId,
      provider: GEN_AI_PROVIDER_NAME,
      vectors: result.embeddings,
    };
  } catch (error) {
    const providerError = createProviderError(error, {
      modelId: params.modelId,
    });
    if (isProviderRetryError(providerError)) {
      throw providerError;
    }

    logException(providerError, "ai.embeddings.failed", {
      "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
      "gen_ai.operation.name": GEN_AI_OPERATION_EMBEDDINGS,
      "gen_ai.request.model": params.modelId,
    });
    throw providerError;
  }
}

/** Read the billed cost that AI Gateway reports in provider metadata. */
export function gatewayCostUsd(providerMetadata: unknown): number | undefined {
  const cost = (
    providerMetadata as { gateway?: { cost?: unknown } } | undefined
  )?.gateway?.cost;
  const value = typeof cost === "string" ? Number(cost) : cost;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Score documents against one query through the host-owned AI Gateway provider. */
export async function rerankTexts(params: {
  documents: string[];
  modelId: string;
  query: string;
  metadata?: Record<string, unknown>;
}): Promise<{ costUsd?: number; scores: number[] }> {
  const query = params.query.trim();
  if (!query || params.documents.length === 0) {
    throw new Error("Reranking query and documents are required.");
  }
  const credential = await resolveGatewayCredential();
  const provider = createGatewayProvider({ apiKey: credential.token });
  try {
    const result = await withLogContext(
      logContextFromMetadata(params.modelId, params.metadata),
      () =>
        rerank({
          model: provider.rerankingModel(params.modelId),
          query,
          documents: params.documents,
          ...aiSdkSpanCallbacks({
            "gen_ai.provider.auth_mode": credential.mode,
            "app.rerank.document.count": params.documents.length,
          }),
        }),
    );
    // The SDK sorts by score. Plugins get scores in input order.
    const scores = params.documents.map(() => Number.NaN);
    for (const { originalIndex, score } of result.ranking) {
      scores[originalIndex] = score;
    }
    if (
      result.ranking.length !== params.documents.length ||
      !scores.every(Number.isFinite)
    ) {
      throw createProviderError("Reranking provider returned invalid scores.", {
        kind: "invalid_response",
        modelId: params.modelId,
      });
    }
    const costUsd = gatewayCostUsd(result.providerMetadata);
    return {
      ...(costUsd !== undefined ? { costUsd } : undefined),
      scores,
    };
  } catch (error) {
    const providerError = createProviderError(error, {
      modelId: params.modelId,
    });
    if (isProviderRetryError(providerError)) {
      throw providerError;
    }

    logException(providerError, "ai.rerank.failed", {
      "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
      "gen_ai.operation.name": GEN_AI_OPERATION_RERANK,
      "gen_ai.request.model": params.modelId,
    });
    throw providerError;
  }
}

const WEB_SEARCH_TOOL_NAME = "parallelSearch";

/** Run one AI Gateway parallel search. */
export async function searchWeb(params: {
  modelId: string;
  query: string;
  maxResults: number;
  signal: AbortSignal;
  promptName?: string;
}) {
  // Use Junior's shared resolver so OIDC wins over a leftover team API key.
  // createGatewayProvider() alone prefers AI_GATEWAY_API_KEY and would keep
  // project attribution as unknown while the key remains set.
  const credential = await resolveGatewayCredential();
  const provider = createGatewayProvider({ apiKey: credential.token });
  const response = await generateText({
    model: provider.chat(params.modelId),
    prompt: params.query,
    tools: {
      [WEB_SEARCH_TOOL_NAME]: provider.tools.parallelSearch({
        mode: "agentic",
        maxResults: params.maxResults,
      }),
    },
    toolChoice: { type: "tool", toolName: WEB_SEARCH_TOOL_NAME },
    abortSignal: params.signal,
    ...(params.promptName
      ? { telemetry: { functionId: params.promptName } }
      : undefined),
    ...aiSdkSpanCallbacks({
      ...(params.promptName
        ? { "gen_ai.prompt.name": params.promptName }
        : undefined),
      "gen_ai.provider.auth_mode": credential.mode,
    }),
  });
  const costUsd = gatewayCostUsd(response.providerMetadata);
  return {
    ...(costUsd !== undefined ? { costUsd } : undefined),
    outputs: response.toolResults
      .filter((result) => result.toolName === WEB_SEARCH_TOOL_NAME)
      .map((result): unknown => result.output),
  };
}

/** Generate or edit images with an AI Gateway image model. */
export async function generateImages(params: {
  modelId: string;
  /** Input images make this an edit of those images. */
  prompt: string | { text: string; images: Buffer[] };
  fetch?: typeof fetch | undefined;
}): Promise<{ costUsd?: number; images: GeneratedFile[] }> {
  const provider = createGatewayProvider({
    apiKey: await getGatewayApiKey(),
    ...(params.fetch ? { fetch: params.fetch } : undefined),
  });
  try {
    const result = await generateImage({
      model: provider.imageModel(params.modelId),
      prompt: params.prompt,
      n: 1,
    });
    const costUsd = gatewayCostUsd(result.providerMetadata);
    return {
      ...(costUsd !== undefined ? { costUsd } : undefined),
      images: result.images,
    };
  } catch (error) {
    if (NoImageGeneratedError.isInstance(error)) return { images: [] };
    throw error;
  }
}
