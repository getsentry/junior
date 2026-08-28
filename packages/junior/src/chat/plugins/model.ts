import type {
  PluginEmbedder,
  PluginModel,
  PluginModelConfig,
} from "@sentry/junior-plugin-api";
import { botConfig } from "@/chat/config";
import { defaultModelId } from "@/chat/model-profile";
import { completeObject, embedTexts } from "@/chat/pi/client";

/** Create the host-owned structured model capability exposed to plugins. */
export function createPluginModel(
  pluginName: string,
  options: PluginModelConfig = {},
  runtime: { signal?: AbortSignal } = {},
): PluginModel {
  return {
    async completeObject(input) {
      const modelId =
        options.structuredModelId ??
        (options.structuredModel === "default"
          ? defaultModelId(botConfig)
          : botConfig.fastModelId);
      const result = await completeObject({
        modelId,
        schema: input.schema,
        prompt: input.prompt,
        ...(input.system !== undefined ? { system: input.system } : undefined),
        ...(input.maxTokens !== undefined
          ? { maxTokens: input.maxTokens }
          : undefined),
        signal: runtime.signal,
        promptName: `${pluginName}.structured_completion`,
        metadata: {
          pluginName,
          pluginModelRole: "structured",
        },
      });
      return {
        object: result.object,
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : undefined),
      };
    },
  };
}

/** Create the host-owned embedding capability exposed to prompt hooks. */
export function createPluginEmbedder(
  pluginName: string,
  runtime: { signal?: AbortSignal } = {},
): PluginEmbedder {
  return {
    async embedTexts(input) {
      return await embedTexts({
        modelId: botConfig.embeddingModelId,
        texts: input.texts,
        signal: runtime.signal,
        metadata: {
          pluginName,
          pluginModelRole: "embedding",
        },
      });
    },
  };
}
