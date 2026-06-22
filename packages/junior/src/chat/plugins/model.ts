import type { PluginEmbedder, PluginModel } from "@sentry/junior-plugin-api";
import { botConfig } from "@/chat/config";
import { completeObject, embedTexts } from "@/chat/pi/client";

/** Create the host-owned structured model capability exposed to plugins. */
export function createPluginModel(pluginName: string): PluginModel {
  return {
    async completeObject(input) {
      const result = await completeObject({
        modelId: botConfig.fastModelId,
        schema: input.schema,
        prompt: input.prompt,
        ...(input.system !== undefined ? { system: input.system } : {}),
        ...(input.maxTokens !== undefined
          ? { maxTokens: input.maxTokens }
          : {}),
        metadata: {
          pluginName,
          pluginModelRole: "structured",
        },
      });
      return { object: result.object };
    },
  };
}

/** Create the host-owned embedding capability exposed to prompt hooks. */
export function createPluginEmbedder(pluginName: string): PluginEmbedder {
  return {
    async embedTexts(input) {
      return await embedTexts({
        modelId: botConfig.embeddingModelId,
        texts: input.texts,
        metadata: {
          pluginName,
          pluginModelRole: "embedding",
        },
      });
    },
  };
}
