import {
  completeSimple,
  getEnvApiKey,
  getModels,
  registerApiProvider,
  streamAnthropic,
  streamSimpleAnthropic,
  type Message,
  type Model,
  type ThinkingLevel,
} from "@/chat/pi/sdk";
import { createGatewayProvider } from "@ai-sdk/gateway";
import { embedMany, generateObject } from "ai";

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
import { toOptionalTrimmed } from "@/chat/optional-string";
import {
  getCurrentConversationPrivacy,
  resolveConversationPrivacy,
  toCanonicalInputMessage,
  toCanonicalOutputMessage,
  toGenAiMessagesTraceAttributes,
} from "@/chat/conversation-privacy";
import {
  createProviderError,
  isProviderRetryError,
} from "@/chat/services/provider-retry";
import { hasCompactedConversationContext } from "@/chat/services/context-compaction-marker";

const GATEWAY_PROVIDER = "vercel-ai-gateway" as const;
export const GEN_AI_PROVIDER_NAME = GATEWAY_PROVIDER;
export const GEN_AI_SERVER_ADDRESS = "ai-gateway.vercel.sh";
export const GEN_AI_SERVER_PORT = 443;
const GEN_AI_OPERATION_CHAT = "chat" as const;
const GEN_AI_OPERATION_EMBEDDINGS = "embeddings" as const;
export const MISSING_GATEWAY_CREDENTIALS_ERROR =
  "Missing AI gateway credentials (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)";

/**
 * Resolve the documented AI Gateway env credentials for the paths that need
 * the bearer token string directly.
 */
export function getGatewayApiKey(): string | undefined {
  return (
    toOptionalTrimmed(getEnvApiKey("vercel-ai-gateway")) ??
    toOptionalTrimmed(process.env.VERCEL_OIDC_TOKEN)
  );
}

/** Return the Gateway credential shape expected by Pi Agent getApiKey hooks. */
export function getPiGatewayApiKey(): string | undefined {
  return getGatewayApiKey();
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
  const apiKey = getPiGatewayApiKey();
  const authMode = toOptionalTrimmed(process.env.AI_GATEWAY_API_KEY)
    ? "api_key"
    : toOptionalTrimmed(process.env.VERCEL_OIDC_TOKEN)
      ? "oidc"
      : "api_key";
  // Identifier metadata can only narrow toward private; the turn-scoped
  // privacy context carries the source-confirmed classification.
  const privacy =
    resolveConversationPrivacy({
      channelId:
        typeof params.metadata?.channelId === "string"
          ? params.metadata.channelId
          : undefined,
      conversationId:
        typeof params.metadata?.conversationId === "string"
          ? params.metadata.conversationId
          : typeof params.metadata?.threadId === "string"
            ? params.metadata.threadId
            : undefined,
    }) ?? getCurrentConversationPrivacy();
  const effectivePrivacy = privacy ?? "private";
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
        throw createProviderError(error);
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
        logWarn(
          "ai_completion_provider_error",
          {},
          {
            ...baseAttributes,
            "exception.message": providerMessage,
          },
          "AI completion returned provider error",
        );
        throw createProviderError(providerMessage);
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
  const slackThreadId =
    typeof metadata?.threadId === "string" ? metadata.threadId : undefined;
  const slackChannelId =
    typeof metadata?.channelId === "string" ? metadata.channelId : undefined;
  const runId =
    typeof metadata?.runId === "string" ? metadata.runId : undefined;

  return {
    modelId,
    ...(conversationId ? { conversationId } : {}),
    ...(slackThreadId ? { slackThreadId } : {}),
    ...(slackChannelId ? { slackChannelId } : {}),
    ...(runId ? { runId } : {}),
  };
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
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}): Promise<{ object: z.infer<TSchema> }> {
  const apiKey = getGatewayApiKey();
  const provider = createGatewayProvider(apiKey ? { apiKey } : {});
  try {
    const result = await withSpan(
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
    return { object: result.object as z.infer<TSchema> };
  } catch (error) {
    const providerError = createProviderError(error);
    if (isProviderRetryError(providerError)) {
      throw providerError;
    }

    logException(
      providerError,
      "ai_completion_failed",
      {},
      {
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
        "gen_ai.request.model": params.modelId,
      },
      "AI object completion failed",
    );
    throw providerError;
  }
}

/** Generate text embeddings through the host-owned AI Gateway provider. */
export async function embedTexts(params: {
  modelId: string;
  texts: string[];
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}): Promise<{
  dimensions: number;
  model: string;
  provider: string;
  vectors: number[][];
}> {
  const texts = params.texts.map((text) => text.trim());
  if (texts.length === 0 || texts.some((text) => text.length === 0)) {
    throw new Error("Embedding text is required.");
  }
  const apiKey = getGatewayApiKey();
  const provider = createGatewayProvider(apiKey ? { apiKey } : {});
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
          throw new Error("Embedding provider returned invalid vectors.");
        }
        setSpanAttributes({
          "gen_ai.embeddings.dimension.count": dimensions,
          ...extractGenAiUsageAttributes(result.usage),
        });
        return { dimensions, result };
      },
      {
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": GEN_AI_OPERATION_EMBEDDINGS,
        "gen_ai.request.model": params.modelId,
        "server.address": GEN_AI_SERVER_ADDRESS,
        "server.port": GEN_AI_SERVER_PORT,
      },
    );
    return {
      dimensions: result.dimensions,
      model: params.modelId,
      provider: GEN_AI_PROVIDER_NAME,
      vectors: result.result.embeddings,
    };
  } catch (error) {
    const providerError = createProviderError(error);
    if (isProviderRetryError(providerError)) {
      throw providerError;
    }

    logException(
      providerError,
      "ai_embeddings_failed",
      {},
      {
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": GEN_AI_OPERATION_EMBEDDINGS,
        "gen_ai.request.model": params.modelId,
      },
      "AI embeddings failed",
    );
    throw providerError;
  }
}
