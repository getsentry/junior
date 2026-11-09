import type { ImageContent, TextContent, Tool } from "@earendil-works/pi-ai";
import { botConfig } from "@/chat/config";
import { resolveGatewayModel } from "@/chat/pi/client";
import type { PiMessage } from "@/chat/pi/messages";

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

// Provider usage is measured. Every other size is counted here, so Junior has
// one counting rule: count the characters that Junior sends, then convert
// them with the model's characters per token.

/**
 * Size-only estimate inputs for the requests of one model. Production
 * provider usage gave these values: Claude counts about 1.6x the tokens of
 * characters / 4 for both replacements and tool results, plus about 150
 * tokens for each tool result. OpenAI models match characters / 4.
 */
interface TokenEstimateProfile {
  charsPerToken: number;
  toolResultOverheadTokens: number;
}

const CLAUDE_TOKEN_ESTIMATE: TokenEstimateProfile = {
  charsPerToken: 2.5,
  toolResultOverheadTokens: 150,
};
// Text estimates that have no model use this profile.
const DEFAULT_TOKEN_ESTIMATE: TokenEstimateProfile = {
  charsPerToken: 4,
  toolResultOverheadTokens: 0,
};

// Pi's own size estimate counts each image as this many characters. Keep the
// same basis.
const IMAGE_CHARS = 4_800;

function getTokenEstimateProfile(modelId: string): TokenEstimateProfile {
  return modelId.startsWith("anthropic/")
    ? CLAUDE_TOKEN_ESTIMATE
    : DEFAULT_TOKEN_ESTIMATE;
}

function tokensForChars(chars: number, profile: TokenEstimateProfile): number {
  return Math.ceil(chars / profile.charsPerToken);
}

// Junior stores only user, assistant, and tool result messages.
function messageChars(message: PiMessage): number {
  switch (message.role) {
    case "user":
    case "toolResult":
      return contentChars(message.content);
    case "assistant": {
      let chars = 0;
      for (const block of message.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else
          chars += block.name.length + JSON.stringify(block.arguments).length;
      }
      return chars;
    }
    default:
      return 0;
  }
}

function contentChars(content: string | (TextContent | ImageContent)[]) {
  if (typeof content === "string") return content.length;
  return content.reduce(
    (chars, block) =>
      chars + (block.type === "text" ? block.text.length : IMAGE_CHARS),
    0,
  );
}

/** Estimate text tokens for local budgets that have no model. */
export function estimateTextTokens(text: string): number {
  return tokensForChars(text.length, DEFAULT_TOKEN_ESTIMATE);
}

/** Convert a local text token budget to the characters it allows. */
export function textCharsForTokens(tokens: number): number {
  return tokens * DEFAULT_TOKEN_ESTIMATE.charsPerToken;
}

/** Estimate messages from their size at the model's characters per token. */
export function estimateMessagesTokens(
  messages: PiMessage[],
  modelId: string,
): number {
  const profile = getTokenEstimateProfile(modelId);
  return messages.reduce((total, message) => {
    const overhead =
      message.role === "toolResult" ? profile.toolResultOverheadTokens : 0;
    return total + tokensForChars(messageChars(message), profile) + overhead;
  }, 0);
}

/** Estimate the tokens that the system prompt and tool definitions add to a model request. */
export function estimateRequestOverheadTokens(
  systemPrompt: string,
  tools: readonly Pick<Tool, "description" | "name" | "parameters">[],
  modelId: string,
): number {
  const definitions = tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  const chars = systemPrompt.length + JSON.stringify(definitions).length;
  return tokensForChars(chars, getTokenEstimateProfile(modelId));
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
