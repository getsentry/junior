import {
  completeSimple,
  getEnvApiKey,
  getModels,
  registerApiProvider,
  type Message,
  type Model,
  type ThinkingLevel,
} from "@mariozechner/pi-ai";
import {
  streamAnthropic,
  streamSimpleAnthropic,
} from "@mariozechner/pi-ai/anthropic";

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
import { logException, logWarn, setSpanAttributes } from "@/chat/logging";
import { toOptionalTrimmed } from "@/chat/optional-string";

const GATEWAY_PROVIDER = "vercel-ai-gateway" as const;
export const GEN_AI_PROVIDER_NAME = GATEWAY_PROVIDER;
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
 * Narrow an arbitrary runtime string (typically from an env var) to a
 * registered gateway model id. Throws fast at the config boundary so stale
 * env overrides fail at startup instead of deep inside a turn.
 */
export function toGatewayModelId(modelId: string): string {
  const models = getModels(GATEWAY_PROVIDER);
  if (!models.some((model: Model<any>) => model.id === modelId)) {
    throw new Error(`Unknown AI Gateway model id: ${modelId}`);
  }
  return modelId;
}

export function resolveGatewayModel(modelId: string): Model<any> {
  const models = getModels(GATEWAY_PROVIDER);
  const matched = models.find((model: Model<any>) => model.id === modelId);
  if (!matched) {
    throw new Error(`Unknown AI Gateway model id: ${modelId}`);
  }
  return matched;
}

export async function completeText(params: {
  modelId: string;
  system?: string;
  messages: Message[];
  thinkingLevel?: ThinkingLevel;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}) {
  const model = resolveGatewayModel(params.modelId);
  const apiKey = getPiGatewayApiKeyOverride();
  const requestMessagesAttribute = serializeGenAiAttribute(params.messages);
  const systemInstructionsAttribute = params.system
    ? serializeGenAiAttribute([{ type: "text", content: params.system }])
    : undefined;
  const startAttributes = {
    "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
    "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
    "gen_ai.request.model": params.modelId,
    ...(systemInstructionsAttribute
      ? { "gen_ai.system_instructions": systemInstructionsAttribute }
      : {}),
    ...(requestMessagesAttribute
      ? { "gen_ai.input.messages": requestMessagesAttribute }
      : {}),
    "app.ai.auth_mode": apiKey ? "oidc" : "api_key",
    ...(params.thinkingLevel
      ? { "app.ai.reasoning_effort": params.thinkingLevel }
      : {}),
  };
  setSpanAttributes(startAttributes);
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
  const outputMessagesAttribute = serializeGenAiAttribute([
    {
      role: "assistant",
      content: outputText ? [{ type: "text", text: outputText }] : [],
    },
  ]);
  const usageAttributes = extractGenAiUsageAttributes(message);
  const endAttributes = {
    "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
    "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
    "gen_ai.request.model": params.modelId,
    ...(outputMessagesAttribute
      ? { "gen_ai.output.messages": outputMessagesAttribute }
      : {}),
    ...usageAttributes,
    ...(message.stopReason
      ? { "gen_ai.response.finish_reasons": [message.stopReason] }
      : {}),
    ...(params.thinkingLevel
      ? { "app.ai.reasoning_effort": params.thinkingLevel }
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
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
        "gen_ai.request.model": params.modelId,
        "error.message": providerMessage,
      },
      "AI completion returned provider error",
    );
    throw new Error(`AI provider error: ${providerMessage}`);
  }

  return {
    message,
    text: outputText,
  };
}

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
  const startedAt = Date.now();
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
        "app.ai.duration_ms": Date.now() - startedAt,
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
        "app.ai.duration_ms": Date.now() - startedAt,
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
