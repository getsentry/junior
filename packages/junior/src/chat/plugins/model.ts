import type {
  PluginDecider,
  PluginEmbedder,
  PluginModel,
  PluginModelConfig,
  PluginReranker,
} from "@sentry/junior-plugin-api";
import { botConfig } from "@/chat/config";
import { defaultModelId } from "@/chat/model-profile";
import {
  completeDecision,
  completeObject,
  embedTexts,
  GEN_AI_PROVIDER_NAME,
  rerankTexts,
} from "@/chat/pi/client";

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
        ...(result.costUsd !== undefined
          ? { costUsd: result.costUsd }
          : undefined),
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
    model: botConfig.embeddingModelId,
    provider: GEN_AI_PROVIDER_NAME,
    async embedTexts(input) {
      return await embedTexts({
        modelId: botConfig.embeddingModelId,
        texts: input.texts,
        ...(input.inputType !== undefined
          ? { inputType: input.inputType }
          : undefined),
        signal: runtime.signal,
        metadata: {
          pluginName,
          pluginModelRole: "embedding",
        },
      });
    },
  };
}

/** Create the host-owned reranking capability exposed to prompt hooks. */
export function createPluginReranker(pluginName: string): PluginReranker {
  return {
    async rerank(input) {
      return await rerankTexts({
        documents: input.documents,
        modelId: botConfig.rerankingModelId,
        query: input.query,
        metadata: {
          pluginName,
          pluginModelRole: "reranking",
        },
      });
    },
  };
}

/** Create the host-owned decision model capability exposed to tool hooks. */
export function createPluginDecider(
  pluginName: string,
  runtime: { signal?: AbortSignal } = {},
): PluginDecider {
  return {
    async decide<TChoice extends string>(input: {
      criteria: Record<TChoice, string>;
      instructions: string;
      state: string;
    }) {
      const result = await completeDecision({
        modelId: botConfig.decisionModelId,
        state: input.state,
        questions: {
          answer: {
            type: "choice",
            instructions: input.instructions,
            criteria: input.criteria,
          },
        },
        signal: runtime.signal,
        promptName: `${pluginName}.decision`,
        metadata: {
          pluginName,
          pluginModelRole: "decision",
        },
      });
      const answer = result.answers.answer;
      return {
        choice: answer.choice as TChoice,
        ...(answer.probabilities
          ? {
              probabilities: answer.probabilities as Partial<
                Record<TChoice, number>
              >,
            }
          : undefined),
        ...(result.costUsd !== undefined
          ? { costUsd: result.costUsd }
          : undefined),
      };
    },
  };
}
