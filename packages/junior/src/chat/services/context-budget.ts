import { botConfig } from "@/chat/config";
import { resolveGatewayModel } from "@/chat/pi/client";

const COMPACTION_TRIGGER_INPUT_RATIO = 0.75;
const COMPACTION_OUTPUT_RESERVE_RATIO = 0.25;
const COMPACTION_TARGET_RATIO = 0.8;
const FALLBACK_CONTEXT_WINDOW_TOKENS = 400_000;
const FALLBACK_MAX_OUTPUT_TOKENS = 128_000;

export interface ModelContextBudget {
  contextWindow: number;
  maxTokens: number;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Estimate text tokens with the shared coarse heuristic used for local budgets. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Derive the automatic compaction threshold from model context capacity. */
export function calculateContextCompactionTriggerTokens(
  model: ModelContextBudget,
): number {
  const contextWindow = positiveInteger(
    model.contextWindow,
    FALLBACK_CONTEXT_WINDOW_TOKENS,
  );
  const maxTokens = positiveInteger(
    model.maxTokens,
    FALLBACK_MAX_OUTPUT_TOKENS,
  );
  const outputReserve = Math.min(
    maxTokens,
    Math.floor(contextWindow * COMPACTION_OUTPUT_RESERVE_RATIO),
  );
  const usableInputTokens = Math.max(1, contextWindow - outputReserve);
  return Math.max(
    1,
    Math.floor(usableInputTokens * COMPACTION_TRIGGER_INPUT_RATIO),
  );
}

/** Derive the post-compaction target from the automatic trigger threshold. */
export function calculateContextCompactionTargetTokens(
  triggerTokens: number,
): number {
  return Math.max(1, Math.floor(triggerTokens * COMPACTION_TARGET_RATIO));
}

/** Resolve the automatic compaction threshold for the active agent model. */
export function getAgentContextCompactionTriggerTokens(): number {
  const model = resolveGatewayModel(botConfig.modelId);
  return calculateContextCompactionTriggerTokens({
    contextWindow: botConfig.modelContextWindowTokens ?? model.contextWindow,
    maxTokens: model.maxTokens,
  });
}

/** Resolve the visible conversation compaction threshold for the auxiliary model. */
export function getConversationContextCompactionTriggerTokens(): number {
  const model = resolveGatewayModel(botConfig.fastModelId);
  return calculateContextCompactionTriggerTokens({
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  });
}
