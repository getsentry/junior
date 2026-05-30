import {
  completeSimple,
  getEnvApiKey,
  getModels,
  registerApiProvider,
  type Message,
  type Model,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  streamAnthropic,
  streamSimpleAnthropic,
} from "@earendil-works/pi-ai/anthropic";

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
  serializeGenAiAttribute,
} from "@/chat/logging";
import {
  logException,
  logWarn,
  setSpanAttributes,
  withSpan,
  type LogContext,
} from "@/chat/logging";
import { toOptionalTrimmed } from "@/chat/optional-string";
import {
  resolveConversationPrivacy,
  toGenAiMessageMetadata,
  toGenAiMessagesTraceAttributes,
  toGenAiTextMetadata,
} from "@/chat/conversation-privacy";

const GATEWAY_PROVIDER = "vercel-ai-gateway" as const;
export const GEN_AI_PROVIDER_NAME = GATEWAY_PROVIDER;
export const GEN_AI_SERVER_ADDRESS = "ai-gateway.vercel.sh";
export const GEN_AI_SERVER_PORT = 443;
const GEN_AI_OPERATION_CHAT = "chat" as const;
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

/**
 * Let pi-ai read AI_GATEWAY_API_KEY from env itself and only override the
 * token when auth comes from VERCEL_OIDC_TOKEN.
 */
export function getPiGatewayApiKeyOverride(): string | undefined {
  // pi-ai already reads AI_GATEWAY_API_KEY from env, so only pass the token
  // ourselves when auth comes from VERCEL_OIDC_TOKEN.
  return toOptionalTrimmed(process.env.VERCEL_OIDC_TOKEN);
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

function parseJsonCandidate(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fencedBlocks = [
      ...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi),
    ];
    for (const block of fencedBlocks) {
      try {
        return JSON.parse(block[1]) as unknown;
      } catch {}
    }

    const openBraceIndex = trimmed.indexOf("{");
    if (openBraceIndex >= 0) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = openBraceIndex; index < trimmed.length; index += 1) {
        const char = trimmed[index];
        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (char === "\\") {
            escaped = true;
            continue;
          }
          if (char === '"') {
            inString = false;
          }
          continue;
        }
        if (char === '"') {
          inString = true;
          continue;
        }
        if (char === "{") {
          depth += 1;
          continue;
        }
        if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            const slice = trimmed.slice(openBraceIndex, index + 1);
            try {
              return JSON.parse(slice) as unknown;
            } catch {
              break;
            }
          }
        }
      }
    }

    return undefined;
  }
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
  const apiKey = getPiGatewayApiKeyOverride();
  const privacy = resolveConversationPrivacy({
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
  });
  const effectivePrivacy = privacy ?? "private";
  const messageAttributeMode =
    params.messageAttributeMode ??
    (effectivePrivacy === "public" ? "content" : "metadata");
  const requestMessagesAttribute = serializeGenAiAttribute(
    messageAttributeMode === "metadata"
      ? params.messages.map(toGenAiMessageMetadata)
      : params.messages,
  );
  const systemInstructionsAttribute = params.system
    ? serializeGenAiAttribute(
        messageAttributeMode === "metadata"
          ? [toGenAiTextMetadata(params.system)]
          : [{ type: "text", content: params.system }],
      )
    : undefined;
  const baseAttributes = {
    "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
    "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
    "gen_ai.request.model": params.modelId,
    "gen_ai.output.type": "text",
    "server.address": GEN_AI_SERVER_ADDRESS,
    "server.port": GEN_AI_SERVER_PORT,
    "app.conversation.privacy": effectivePrivacy,
    ...(params.thinkingLevel
      ? { "app.ai.reasoning_effort": params.thinkingLevel }
      : {}),
  };
  const startAttributes = {
    ...baseAttributes,
    ...toGenAiMessagesTraceAttributes("app.ai.input", params.messages),
    ...(params.system
      ? { "app.ai.system_instructions.content_chars": params.system.length }
      : {}),
    ...(systemInstructionsAttribute
      ? { "gen_ai.system_instructions": systemInstructionsAttribute }
      : {}),
    ...(requestMessagesAttribute
      ? { "gen_ai.input.messages": requestMessagesAttribute }
      : {}),
    "app.ai.auth_mode": apiKey ? "oidc" : "api_key",
  };
  return withSpan(
    `${GEN_AI_OPERATION_CHAT} ${params.modelId}`,
    "gen_ai.chat",
    logContextFromMetadata(params.modelId, params.metadata),
    async () => {
      const message = await completeSimple(
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
      const outputText = extractText(message);
      const outputMessagesAttribute = serializeGenAiAttribute(
        messageAttributeMode === "metadata"
          ? [
              {
                role: "assistant",
                content: outputText ? [toGenAiTextMetadata(outputText)] : [],
              },
            ]
          : [
              {
                role: "assistant",
                content: outputText ? [{ type: "text", text: outputText }] : [],
              },
            ],
      );
      const usageAttributes = extractGenAiUsageAttributes(message);
      const endAttributes = {
        ...baseAttributes,
        ...toGenAiMessagesTraceAttributes("app.ai.output", [
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
          ? { "gen_ai.response.finish_reasons": [message.stopReason] }
          : {}),
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
        throw new Error(`AI provider error: ${providerMessage}`);
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

/** Execute a schema-constrained completion using the traced text path above. */
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
}): Promise<{ object: z.infer<TSchema>; text: string }> {
  let text = "";
  try {
    ({ text } = await completeText({
      modelId: params.modelId,
      system: params.system,
      thinkingLevel: params.thinkingLevel,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      signal: params.signal,
      metadata: params.metadata,
      messages: [
        {
          role: "user",
          content: params.prompt,
          timestamp: Date.now(),
        },
      ],
    }));
  } catch (error) {
    logException(
      error,
      "ai_completion_failed",
      {},
      {
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
        "gen_ai.request.model": params.modelId,
      },
      "AI object completion failed",
    );
    throw error;
  }

  const candidate = parseJsonCandidate(text);
  const parsed = params.schema.safeParse(candidate);
  if (!parsed.success) {
    const preview = text.length > 400 ? `${text.slice(0, 400)}...` : text;
    logWarn(
      "ai_completion_schema_parse_failed",
      {},
      {
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
        "gen_ai.request.model": params.modelId,
        "app.ai.response_preview": preview,
      },
      "AI object completion schema parse failed",
    );
    throw new Error(
      `Model did not return valid JSON for schema: ${parsed.error.message}. Raw response: ${preview}`,
    );
  }

  return {
    object: parsed.data,
    text,
  };
}
