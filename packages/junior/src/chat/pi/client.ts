import {
  calculateCost,
  completeSimple,
  getModels,
  registerApiProvider,
  streamAnthropic,
  streamSimpleAnthropic,
  type Message,
  type Model,
  type ThinkingLevel,
} from "@/chat/pi/sdk";
import { createGatewayProvider } from "@ai-sdk/gateway";
import {
  resolveGatewayCredential,
  type GatewayCredential,
} from "@/chat/pi/gateway-auth";

export {
  getGatewayApiKey,
  getPiGatewayApiKey,
  MISSING_GATEWAY_CREDENTIALS_ERROR,
  resolveGatewayCredential,
  type GatewayAuthMode,
  type GatewayCredential,
} from "@/chat/pi/gateway-auth";
import {
  embedMany,
  generateObject,
  NoObjectGeneratedError,
  type GenerateObjectResult,
  type LanguageModelUsage,
} from "ai";

// Directly register the anthropic provider at import time. pi-ai's built-in
// registration relies on opaque dynamic import() calls that break under
// Nitro's rolldown bundler (the lazy import paths resolve relative to the
// bundled chunk, not the original module).
registerApiProvider({
  api: "anthropic-messages",
  stream: streamAnthropic,
  streamSimple: streamSimpleAnthropic,
});
import type { ZodTypeAny, z } from "zod";
import {
  extractGenAiUsageAttributes,
  normalizeGenAiFinishReason,
  serializeGenAiAttribute,
} from "@/chat/logging";
import {
  logException,
  logWarn,
  withSpan,
  type LogContext,
} from "@/chat/logging";
import {
  getCurrentConversationPrivacy,
  toCanonicalInputMessage,
  toCanonicalOutputMessage,
  toGenAiMessagesTraceAttributes,
} from "@/chat/conversation-privacy";
import {
  createProviderError,
  isProviderRetryError,
} from "@/chat/services/provider-error";
import { hasCompactedConversationContext } from "@/chat/services/context-compaction-marker";

const GATEWAY_PROVIDER = "vercel-ai-gateway" as const;
export const GEN_AI_PROVIDER_NAME = GATEWAY_PROVIDER;
export const GEN_AI_SERVER_ADDRESS = "ai-gateway.vercel.sh";
export const GEN_AI_SERVER_PORT = 443;
const GEN_AI_OPERATION_CHAT = "chat" as const;
const GEN_AI_OPERATION_EMBEDDINGS = "embeddings" as const;
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
};
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

/** Build an AI SDK gateway provider from the resolved Junior credential. */
function createResolvedGatewayProvider(credential: GatewayCredential | undefined) {
  // Pass the token only when Junior resolved one. Leaving apiKey unset lets the
  // AI SDK retry ambient OIDC/API-key discovery for paths that skip our helper.
  return createGatewayProvider(credential ? { apiKey: credential.token } : {});
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

/**
 * Look up a gateway model by id. Throws `Unknown AI Gateway model id: …` if
 * the id is not in pi-ai's registry — callers at the config boundary can use
 * this to fail fast at startup instead of mid-turn.
 */
export function resolveGatewayModel(modelId: string): Model<any> {
  const matched = getModels(GATEWAY_PROVIDER).find(
    (model: Model<any>) => model.id === modelId,
  );
  if (!matched) {
    throw new Error(`Unknown AI Gateway model id: ${modelId}`);
  }
  return matched;
}

/** Execute a direct chat completion inside a dedicated `gen_ai.chat` span. */
export async function completeText(params: {
  modelId: string;
  system?: string;
  messages: Message[];
  messageAttributeMode?: "content" | "metadata";
  thinkingLevel?: ThinkingLevel;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}) {
  const model = resolveGatewayModel(params.modelId);
  const credential = await resolveGatewayCredential();
  const apiKey = credential?.token;
  const authMode = credential?.mode ?? "api_key";
  const effectivePrivacy = getCurrentConversationPrivacy() ?? "private";
  const messageAttributeMode =
    params.messageAttributeMode ??
    (effectivePrivacy === "public" ? "content" : "metadata");
  const requestMessagesAttribute =
    messageAttributeMode === "content"
      ? serializeGenAiAttribute(params.messages.map(toCanonicalInputMessage))
      : undefined;
  const systemInstructionsAttribute =
    params.system && messageAttributeMode === "content"
      ? serializeGenAiAttribute([{ type: "text", content: params.system }])
      : undefined;
  const baseAttributes = {
    "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
    "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
    "gen_ai.request.model": params.modelId,
    "gen_ai.output.type": "text",
    "server.address": GEN_AI_SERVER_ADDRESS,
    "server.port": GEN_AI_SERVER_PORT,
    ...(hasCompactedConversationContext(params.messages)
      ? { "gen_ai.conversation.compacted": true }
      : {}),
    "app.conversation.privacy": effectivePrivacy,
    ...(params.thinkingLevel
      ? { "gen_ai.request.reasoning.level": params.thinkingLevel }
      : {}),
    ...(params.temperature !== undefined
      ? { "gen_ai.request.temperature": params.temperature }
      : {}),
    ...(params.maxTokens !== undefined
      ? { "gen_ai.request.max_tokens": params.maxTokens }
      : {}),
  };
  const startAttributes = {
    ...baseAttributes,
    ...toGenAiMessagesTraceAttributes("gen_ai.input", params.messages),
    ...(params.system
      ? { "gen_ai.system_instructions.content_chars": params.system.length }
      : {}),
    ...(systemInstructionsAttribute
      ? { "gen_ai.system_instructions": systemInstructionsAttribute }
      : {}),
    ...(requestMessagesAttribute
      ? { "gen_ai.input.messages": requestMessagesAttribute }
      : {}),
    "gen_ai.provider.auth_mode": authMode,
  };
  return withSpan(
    `${GEN_AI_OPERATION_CHAT} ${params.modelId}`,
    "gen_ai.chat",
    logContextFromMetadata(params.modelId, params.metadata),
    async (setSpanAttributes) => {
      let message: Awaited<ReturnType<typeof completeSimple>>;
      try {
        message = await completeSimple(
          model,
          {
            systemPrompt: params.system,
            messages: params.messages,
          },
          {
            ...(apiKey ? { apiKey } : {}),
            temperature: params.temperature,
            maxTokens: params.maxTokens,
            reasoning: params.thinkingLevel,
            signal: params.signal,
            metadata: params.metadata,
          },
        );
      } catch (error) {
        throw createProviderError(error, { modelId: params.modelId });
      }
      const outputText = extractText(message);
      const outputMessagesAttribute = serializeGenAiAttribute(
        messageAttributeMode === "content"
          ? [toCanonicalOutputMessage(message)]
          : undefined,
      );
      const usageAttributes = extractGenAiUsageAttributes(message);
      const endAttributes = {
        ...baseAttributes,
        ...toGenAiMessagesTraceAttributes("gen_ai.output", [
          {
            role: "assistant",
            content: outputText ? [{ type: "text", text: outputText }] : [],
          },
        ]),
        ...(outputMessagesAttribute
          ? { "gen_ai.output.messages": outputMessagesAttribute }
          : {}),
        ...usageAttributes,
        ...(message.stopReason
          ? {
              "gen_ai.response.finish_reasons": [
                normalizeGenAiFinishReason(message.stopReason),
              ],
            }
          : {}),
        ...(message.model ? { "gen_ai.response.model": message.model } : {}),
      };
      setSpanAttributes(endAttributes);
      if (message.stopReason === "error") {
        const providerMessage =
          message.errorMessage?.trim() || "Unknown provider error";
        logWarn("ai.completion.provider_error", {
          ...baseAttributes,
          "exception.message": providerMessage,
        });
        throw createProviderError(providerMessage, { modelId: params.modelId });
      }

      return {
        message,
        text: outputText,
      };
    },
    startAttributes,
  );
}

function logContextFromMetadata(
  modelId: string,
  metadata: Record<string, unknown> | undefined,
): LogContext {
  const conversationId =
    typeof metadata?.conversationId === "string"
      ? metadata.conversationId
      : typeof metadata?.threadId === "string"
        ? metadata.threadId
        : undefined;
  const messageConversationId =
    typeof metadata?.threadId === "string" ? metadata.threadId : undefined;
  const destinationName =
    typeof metadata?.channelId === "string" ? metadata.channelId : undefined;
  const runId =
    typeof metadata?.runId === "string" ? metadata.runId : undefined;

  return {
    modelId,
    ...(conversationId ? { conversationId } : {}),
    ...(messageConversationId ? { messageConversationId } : {}),
    ...(destinationName ? { destinationName } : {}),
    ...(runId ? { runId } : {}),
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
      : {}),
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
  temperature?: number;
  maxTokens?: number;
  /**
   * `false` retains telemetry spans and metrics while omitting model inputs and
   * outputs. Omission preserves the existing payload-recording behavior.
   */
  recordTelemetryPayloads?: boolean;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}): Promise<{ costUsd?: number; object: z.infer<TSchema> }> {
  const credential = await resolveGatewayCredential();
  const provider = createResolvedGatewayProvider(credential);
  let result: GenerateObjectResult<unknown>;
  try {
    result = await withSpan(
      `${GEN_AI_OPERATION_CHAT} ${params.modelId}`,
      "gen_ai.chat",
      logContextFromMetadata(params.modelId, params.metadata),
      async (setSpanAttributes) => {
        const result = await generateObject({
          model: provider.chat(params.modelId),
          schema: params.schema,
          prompt: params.prompt,
          ...(params.system !== undefined ? { system: params.system } : {}),
          ...(params.temperature !== undefined
            ? { temperature: params.temperature }
            : {}),
          ...(params.maxTokens !== undefined
            ? { maxOutputTokens: params.maxTokens }
            : {}),
          ...(params.recordTelemetryPayloads === false
            ? {
                experimental_telemetry: {
                  isEnabled: true,
                  recordInputs: false,
                  recordOutputs: false,
                },
              }
            : {}),
          ...(params.signal !== undefined
            ? { abortSignal: params.signal }
            : {}),
        });
        setSpanAttributes({
          "gen_ai.response.finish_reasons": [result.finishReason],
          ...extractGenAiUsageAttributes(result.usage),
        });
        return result;
      },
      {
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
        "gen_ai.request.model": params.modelId,
        "gen_ai.output.type": "json",
        "server.address": GEN_AI_SERVER_ADDRESS,
        "server.port": GEN_AI_SERVER_PORT,
        "gen_ai.provider.auth_mode": credential?.mode ?? "api_key",
        ...(params.thinkingLevel
          ? { "gen_ai.request.reasoning.level": params.thinkingLevel }
          : {}),
        ...(params.temperature !== undefined
          ? { "gen_ai.request.temperature": params.temperature }
          : {}),
        ...(params.maxTokens !== undefined
          ? { "gen_ai.request.max_tokens": params.maxTokens }
          : {}),
      },
    );
  } catch (error) {
    const providerError = createProviderError(error, {
      ...(NoObjectGeneratedError.isInstance(error)
        ? { kind: "invalid_response" }
        : {}),
      modelId: params.modelId,
    });
    throw providerError;
  }
  const costUsd = bestEffortObjectCompletionCost(params.modelId, result.usage);
  return {
    object: result.object as z.infer<TSchema>,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/** Generate text embeddings through the host-owned AI Gateway provider. */
export async function embedTexts(params: {
  modelId: string;
  texts: string[];
  signal?: AbortSignal;
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
  const provider = createResolvedGatewayProvider(credential);
  try {
    const result = await withSpan(
      `${GEN_AI_OPERATION_EMBEDDINGS} ${params.modelId}`,
      "gen_ai.embeddings",
      logContextFromMetadata(params.modelId, params.metadata),
      async (setSpanAttributes) => {
        const result = await embedMany({
          model: provider.embeddingModel(params.modelId),
          values: texts,
          ...(params.signal !== undefined
            ? { abortSignal: params.signal }
            : {}),
        });
        const dimensions = result.embeddings[0]?.length;
        if (
          result.embeddings.length !== texts.length ||
          !dimensions ||
          !result.embeddings.every(
            (embedding) => embedding.length === dimensions,
          )
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
        setSpanAttributes({
          "gen_ai.embeddings.dimension.count": dimensions,
          ...extractGenAiUsageAttributes({
            inputTokens: result.usage.tokens,
            ...(costUsd !== undefined
              ? { cost: { input: costUsd, total: costUsd } }
              : {}),
          }),
        });
        return { costUsd, dimensions, result };
      },
      {
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": GEN_AI_OPERATION_EMBEDDINGS,
        "gen_ai.request.model": params.modelId,
        "server.address": GEN_AI_SERVER_ADDRESS,
        "server.port": GEN_AI_SERVER_PORT,
        "gen_ai.provider.auth_mode": credential?.mode ?? "api_key",
      },
    );
    return {
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      dimensions: result.dimensions,
      model: params.modelId,
      provider: GEN_AI_PROVIDER_NAME,
      vectors: result.result.embeddings,
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
