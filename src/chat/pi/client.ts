import { completeSimple, getEnvApiKey, getModels, type Message, type Model } from "@mariozechner/pi-ai";
import type { ZodTypeAny, z } from "zod";

const GATEWAY_PROVIDER = "vercel-ai-gateway" as const;

export function getGatewayApiKey(): string | undefined {
  return getEnvApiKey("vercel-ai-gateway");
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
  const model = resolveGatewayModel(params.modelId);
  const apiKey = getGatewayApiKey();
  if (!apiKey) {
    throw new Error("AI_GATEWAY_API_KEY is required for model completion");
  }
  const message = await completeSimple(
    model,
    {
      systemPrompt: params.system,
      messages: params.messages
    },
    {
      apiKey,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      signal: params.signal,
      metadata: params.metadata
    }
  );

  return {
    message,
    text: extractText(message)
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
  const { text } = await completeText({
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
  });

  const candidate = parseJsonCandidate(text);
  const parsed = params.schema.safeParse(candidate);
  if (!parsed.success) {
    const preview = text.length > 400 ? `${text.slice(0, 400)}...` : text;
    throw new Error(`Model did not return valid JSON for schema: ${parsed.error.message}. Raw response: ${preview}`);
  }

  return {
    object: parsed.data,
    text
  };
}
