import { botConfig } from "@/chat/config";
import { resolveGatewayModel } from "@/chat/pi/client";

const COMPACTION_TRIGGER_RATIO = 0.9;
const CONTEXT_INPUT_LIMIT_RATIO = 0.95;
const COMPACTION_TARGET_RATIO = 0.8;
// Share of the compaction threshold where a background summary starts, so it
// is ready before blocking compaction would run.
const BACKGROUND_COMPACTION_MARK_RATIO = 0.7;
const FALLBACK_CONTEXT_WINDOW_TOKENS = 400_000;

export interface ModelContextBudget {
  contextWindow: number;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Derive the automatic compaction threshold from model context capacity. */
export function calculateContextCompactionTriggerTokens(
  model: ModelContextBudget,
): number {
  const contextWindow = positiveInteger(
    model.contextWindow,
    FALLBACK_CONTEXT_WINDOW_TOKENS,
  );
  return Math.max(1, Math.floor(contextWindow * COMPACTION_TRIGGER_RATIO));
}

/** Derive the maximum estimated input size with room for uncounted request overhead. */
export function calculateContextInputLimitTokens(
  model: ModelContextBudget,
): number {
  const contextWindow = positiveInteger(
    model.contextWindow,
    FALLBACK_CONTEXT_WINDOW_TOKENS,
  );
  return Math.max(1, Math.floor(contextWindow * CONTEXT_INPUT_LIMIT_RATIO));
}

/** Derive the post-compaction target from the automatic trigger threshold. */
export function calculateContextCompactionTargetTokens(
  triggerTokens: number,
): number {
  return Math.max(1, Math.floor(triggerTokens * COMPACTION_TARGET_RATIO));
}

/** Cap one model's advertised context capacity with the host bot configuration. */
export function getModelContextBudget(modelId: string): ModelContextBudget {
  const model = resolveGatewayModel(modelId);
  const advertisedContextWindow = positiveInteger(
    model.contextWindow,
    FALLBACK_CONTEXT_WINDOW_TOKENS,
  );
  return {
    contextWindow: Math.min(
      botConfig.contextWindowTokens,
      advertisedContextWindow,
    ),
  };
}

/** Resolve the automatic compaction threshold for the active agent model. */
export function getAgentContextCompactionTriggerTokens(
  modelId: string,
): number {
  return calculateContextCompactionTriggerTokens(
    getModelContextBudget(modelId),
  );
}

/**
 * Resolve the input size where a Turn requests a background summary for the
 * active agent model. It is below the compaction threshold of the same budget.
 */
export function getAgentBackgroundCompactionMarkTokens(
  modelId: string,
): number {
  return Math.max(
    1,
    Math.floor(
      getAgentContextCompactionTriggerTokens(modelId) *
        BACKGROUND_COMPACTION_MARK_RATIO,
    ),
  );
}

/** Resolve the hard input ceiling for the active agent model. */
export function getAgentContextInputLimitTokens(modelId: string): number {
  return calculateContextInputLimitTokens(getModelContextBudget(modelId));
}

/** Resolve the visible conversation compaction threshold for the auxiliary model. */
export function getConversationContextCompactionTriggerTokens(): number {
  return calculateContextCompactionTriggerTokens(
    getModelContextBudget(botConfig.fastModelId),
  );
}
