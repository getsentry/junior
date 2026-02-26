import { completeSimple, getEnvApiKey, getModels, type Message, type Model } from "@mariozechner/pi-ai";
import type { ZodTypeAny, z } from "zod";
import { extractGenAiUsageAttributes, serializeGenAiAttribute } from "@/chat/gen-ai-attributes";
import { logException, logInfo, logWarn, setSpanAttributes } from "@/chat/observability";

const GATEWAY_PROVIDER = "vercel-ai-gateway" as const;
export const GEN_AI_PROVIDER_NAME = GATEWAY_PROVIDER;
const GEN_AI_OPERATION_CHAT = "chat" as const;

export function getGatewayApiKey(): string | undefined {
  return getEnvApiKey("vercel-ai-gateway") || process.env.VERCEL_OIDC_TOKEN;
}

function extractText(message: { content?: Array<{ type: string; text?: string }> }): string {
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
    const fencedBlocks = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
    for (const block of fencedBlocks) {
      try {
        return JSON.parse(block[1]) as unknown;
      } catch {
        // continue
      }
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
          if (char === "\"") {
            inString = false;
          }
          continue;
        }
        if (char === "\"") {
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
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}) {
  const startedAt = Date.now();
  const model = resolveGatewayModel(params.modelId);
  const apiKey = getGatewayApiKey();
  const requestMessagesAttribute = serializeGenAiAttribute(params.messages);
  const startAttributes = {
    "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
    "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
    "gen_ai.request.model": params.modelId,
    ...(requestMessagesAttribute ? { "gen_ai.input.messages": requestMessagesAttribute } : {}),
    "app.ai.auth_mode": apiKey ? "api_key" : "ambient"
  };
  setSpanAttributes(startAttributes);
  logInfo(
    "ai_completion_start",
    {},
    startAttributes,
    "AI completion started"
  );
  const message = await completeSimple(model, {
    systemPrompt: params.system,
    messages: params.messages
  }, {
    ...(apiKey ? { apiKey } : {}),
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    signal: params.signal,
    metadata: params.metadata
  });
  const outputText = extractText(message);
  const outputMessagesAttribute = serializeGenAiAttribute([
    {
      role: "assistant",
      content: outputText ? [{ type: "text", text: outputText }] : []
    }
  ]);
  const usageAttributes = extractGenAiUsageAttributes(message);
  const endAttributes = {
    "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
    "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
    "gen_ai.request.model": params.modelId,
    ...(outputMessagesAttribute ? { "gen_ai.output.messages": outputMessagesAttribute } : {}),
    ...usageAttributes,
    "app.ai.duration_ms": Date.now() - startedAt,
    "app.ai.stop_reason": message.stopReason ?? "unknown"
  };
  setSpanAttributes(endAttributes);
  logInfo(
    "ai_completion_end",
    {},
    endAttributes,
    "AI completion finished"
  );
  if (message.stopReason === "error") {
    const providerMessage = message.errorMessage?.trim() || "Unknown provider error";
    logWarn(
      "ai_completion_provider_error",
      {},
      {
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
        "gen_ai.request.model": params.modelId,
        "error.message": providerMessage
      },
      "AI completion returned provider error"
    );
    throw new Error(`AI provider error: ${providerMessage}`);
  }

  return {
    message,
    text: outputText
  };
}

export async function completeObject<TSchema extends ZodTypeAny>(params: {
  modelId: string;
  schema: TSchema;
  system?: string;
  prompt: string;
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
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      signal: params.signal,
      metadata: params.metadata,
      messages: [
        {
          role: "user",
          content: params.prompt,
          timestamp: Date.now()
        }
      ]
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
        "app.ai.duration_ms": Date.now() - startedAt
      },
      "AI object completion failed"
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
        "app.ai.response_preview": preview
      },
      "AI object completion schema parse failed"
    );
    throw new Error(`Model did not return valid JSON for schema: ${parsed.error.message}. Raw response: ${preview}`);
  }

  logInfo(
    "ai_completion_object_end",
    {},
    {
      "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
      "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
      "gen_ai.request.model": params.modelId,
      "app.ai.duration_ms": Date.now() - startedAt
    },
    "AI object completion finished"
  );

  return {
    object: parsed.data,
    text
  };
}
