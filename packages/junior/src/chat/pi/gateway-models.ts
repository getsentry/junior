// AI Gateway model metadata. Config validates model ids with it, so it must
// stay free of the model client and its logging and telemetry imports.
import { getModels, type Api, type Model } from "@/chat/pi/sdk";

/** Pi provider name for AI Gateway models. */
export const GATEWAY_PROVIDER = "vercel-ai-gateway" as const;
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
/** Find a gateway model through local overrides, then Pi's bundled catalog. */
export function findGatewayModel(modelId: string): Model<Api> | undefined {
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
