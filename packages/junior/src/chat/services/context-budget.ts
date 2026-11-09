import type { ImageContent, TextContent, Tool } from "@earendil-works/pi-ai";
import { botConfig } from "@/chat/config";
import { resolveGatewayModel } from "@/chat/pi/client";
import type { PiMessage } from "@/chat/pi/messages";
import { readImageDimensions } from "@/chat/services/image-dimensions";

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
// them with the model's characters per token. Claude counts images by their
// pixel size, so Claude images use that rule instead.

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

// Pi's own size estimate counts each image as this many characters. Images
// without a Claude size estimate keep this basis.
const IMAGE_CHARS = 4_800;

interface ClaudeImageLimits {
  maxEdge: number;
  maxTokens: number;
}

// Resolution tiers from "Resolution and token cost" in
// https://platform.claude.com/docs/en/build-with-claude/vision: Claude 4.7 and
// later models are high-resolution, all other models are standard. New
// models are high-resolution, so only Claude 3 and Claude 4 to 4.6 ids are
// standard.
const CLAUDE_HIGH_RES_IMAGE: ClaudeImageLimits = {
  maxEdge: 2_576,
  maxTokens: 4_784,
};
const CLAUDE_STANDARD_IMAGE: ClaudeImageLimits = {
  maxEdge: 1_568,
  maxTokens: 1_568,
};
const CLAUDE_STANDARD_IMAGE_MODEL =
  /^anthropic\/claude-(?:3\b|[a-z]+-4(?:\.[0-6])?(?![.\d]))/;
const CLAUDE_IMAGE_PATCH_PX = 28;

function getTokenEstimateProfile(modelId: string): TokenEstimateProfile {
  return modelId.startsWith("anthropic/")
    ? CLAUDE_TOKEN_ESTIMATE
    : DEFAULT_TOKEN_ESTIMATE;
}

function tokensForChars(chars: number, profile: TokenEstimateProfile): number {
  return Math.ceil(chars / profile.charsPerToken);
}

// Junior stores only user, assistant, and tool result messages. Images are
// counted by `imageTokens`.
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
    (chars, block) => chars + (block.type === "text" ? block.text.length : 0),
    0,
  );
}

function messageImages(message: PiMessage): ImageContent[] {
  if (message.role !== "user" && message.role !== "toolResult") return [];
  if (typeof message.content === "string") return [];
  return message.content.filter((block) => block.type === "image");
}

function claudeImagePatches(width: number, height: number): number {
  return (
    Math.ceil(width / CLAUDE_IMAGE_PATCH_PX) *
    Math.ceil(height / CLAUDE_IMAGE_PATCH_PX)
  );
}

// Python's round(): the API resolves exact .5 ties toward the even neighbor.
function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * The size Claude resizes an image to before it counts patches. This is the
 * reference implementation in "How Claude resizes and pads images" in
 * https://platform.claude.com/docs/en/build-with-claude/vision-coordinates:
 * the largest aspect-preserving size whose padded edges and patch count fit
 * the tier limits.
 */
function claudeResizedImageSize(
  width: number,
  height: number,
  limits: ClaudeImageLimits,
): [number, number] {
  const fits = (w: number, h: number) =>
    Math.ceil(w / CLAUDE_IMAGE_PATCH_PX) * CLAUDE_IMAGE_PATCH_PX <=
      limits.maxEdge &&
    Math.ceil(h / CLAUDE_IMAGE_PATCH_PX) * CLAUDE_IMAGE_PATCH_PX <=
      limits.maxEdge &&
    claudeImagePatches(w, h) <= limits.maxTokens;

  if (fits(width, height)) return [width, height];
  if (height > width) {
    const [resizedHeight, resizedWidth] = claudeResizedImageSize(
      height,
      width,
      limits,
    );
    return [resizedWidth, resizedHeight];
  }
  // Binary search on the long edge. `low` always fits, `high` never fits.
  const aspectRatio = width / height;
  const shortEdge = (longEdge: number) =>
    Math.max(roundHalfToEven(longEdge / aspectRatio), 1);
  let low = 1;
  let high = width;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid, shortEdge(mid))) low = mid;
    else high = mid;
  }
  return [low, shortEdge(low)];
}

function imageTokens(
  image: ImageContent,
  modelId: string,
  profile: TokenEstimateProfile,
): number {
  const dimensions = modelId.startsWith("anthropic/")
    ? readImageDimensions(image)
    : undefined;
  if (!dimensions) return tokensForChars(IMAGE_CHARS, profile);
  const limits = CLAUDE_STANDARD_IMAGE_MODEL.test(modelId)
    ? CLAUDE_STANDARD_IMAGE
    : CLAUDE_HIGH_RES_IMAGE;
  const [width, height] = claudeResizedImageSize(
    dimensions.width,
    dimensions.height,
    limits,
  );
  return claudeImagePatches(width, height);
}

/** Estimate text tokens for local budgets that have no model. */
export function estimateTextTokens(text: string): number {
  return tokensForChars(text.length, DEFAULT_TOKEN_ESTIMATE);
}

/** Convert a local text token budget to the characters it allows. */
export function textCharsForTokens(tokens: number): number {
  return tokens * DEFAULT_TOKEN_ESTIMATE.charsPerToken;
}

/**
 * Estimate messages from their text size at the model's characters per token,
 * plus the tokens of each image.
 */
export function estimateMessagesTokens(
  messages: PiMessage[],
  modelId: string,
): number {
  const profile = getTokenEstimateProfile(modelId);
  return messages.reduce((total, message) => {
    const overhead =
      message.role === "toolResult" ? profile.toolResultOverheadTokens : 0;
    const images = messageImages(message).reduce(
      (tokens, image) => tokens + imageTokens(image, modelId, profile),
      0,
    );
    return (
      total + tokensForChars(messageChars(message), profile) + images + overhead
    );
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
