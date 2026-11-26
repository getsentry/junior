import {
  DEFAULT_COMPLETED_REACTION_EMOJI,
  DEFAULT_FUNCTION_MAX_DURATION_SECONDS,
  DEFAULT_PROCESSING_REACTION_EMOJI,
  loadConfig,
  resolveConversationWorkSoftYieldAfterMs,
  resolveMaxTurnTimeoutMs,
  type JuniorConfig,
} from "@/config";
import { resolveBotName } from "@/chat/bot-name";
import { toOptionalTrimmed } from "@/chat/optional-string";
import { resolveGatewayModel } from "@/chat/pi/client";
import { normalizeSlackEmojiName } from "@/chat/slack/emoji";

export interface BotModelConfig {
  /** Model that runs every agent Turn. */
  modelId?: string;
  /** Decision model used by the passive reply router. */
  decisionModelId?: string;
  /** Model used for embeddings. */
  embeddingModelId?: string;
  /** Model used for low-cost structured and utility calls. */
  fastModelId?: string;
  /** Model used to rerank plugin retrieval candidates. */
  rerankingModelId?: string;
  /** Model used to review sensitive tool calls. */
  guardianModelId?: string;
  /** Model used to generate images. */
  imageGenerationModelId?: string;
  /** Model used to transcribe audio and video attachments. */
  transcriptionModelId?: string;
  /** Model used to analyze images. */
  visionModelId?: string;
  /** Model used for web search. */
  webSearchModelId?: string;
  /** Model that continues an agent Turn after the main model refuses it. Unset by default. */
  refusalFallbackModelId?: string;
}

export type ChatConfig = JuniorConfig;
export type BotConfig = ChatConfig["bot"];
export type SqlDriver = ChatConfig["sql"]["driver"];

function resolveFunctionMaxDurationSeconds(
  functionMaxDurationSeconds?: number,
): number {
  return functionMaxDurationSeconds ?? DEFAULT_FUNCTION_MAX_DURATION_SECONDS;
}

function validateGatewayModelId(raw: string | undefined): string | undefined {
  const trimmed = toOptionalTrimmed(raw);
  if (trimmed === undefined) return undefined;
  resolveGatewayModel(trimmed);
  return trimmed;
}

function validateEmbeddingModelId(raw: string | undefined): string | undefined {
  return toOptionalTrimmed(raw);
}

function requireModelId(
  configName: keyof BotModelConfig,
  raw: string,
  validate: (value: string | undefined) => string | undefined,
): string {
  const modelId = validate(raw);
  if (!modelId) {
    throw new Error(`${configName} must not be empty`);
  }
  return modelId;
}

function parseReactionEmoji(
  envName: string,
  rawValue: string | undefined,
  defaultEmoji: string,
): string {
  const trimmed = toOptionalTrimmed(rawValue);
  if (trimmed === undefined) {
    return defaultEmoji;
  }
  const normalized = normalizeSlackEmojiName(trimmed);
  if (!normalized) {
    throw new Error(
      `${envName} must be a valid Slack emoji name (for example "eyes" or ":white_check_mark:")`,
    );
  }
  return normalized;
}

/** Parse all chat configuration from environment variables. */
export function readChatConfig(
  env: NodeJS.ProcessEnv = process.env,
  functionMaxDurationSeconds?: number,
): ChatConfig {
  return loadConfig({ env, options: { functionMaxDurationSeconds } });
}

/** Chat configuration parsed once at module load from the process environment. */
const chatConfig: ChatConfig = readChatConfig(process.env);

/** Limits a host can set with `createApp({ limits })`. */
export interface RuntimeLimits {
  /** Largest model context window used for compaction, in tokens. */
  contextWindowTokens?: number;
  /**
   * Levels of child agents that can start their own child agents. The
   * default, 1, lets a child of the root start child agents, and those
   * cannot start more. 0 lets only the root Conversation start them.
   */
  maxAgentDepth?: number;
  /** Automated turns in a row before Junior stops answering automation. */
  maxConsecutiveAutomatedTurns?: number;
  /** Runs one Event automation can start in a rolling window. */
  eventAutomationRunLimit?: {
    /** Runs allowed in one window. The default is 10. */
    maxRuns?: number;
    /** Window length in ms. The default, 60000, is one minute. */
    windowMs?: number;
  };
  /** Run slices one turn may use. */
  maxSlicesPerTurn?: number;
  /** Tool calls one turn may make. */
  maxToolCallsPerTurn?: number;
  /** Model spend in whole USD one turn may use. */
  maxTurnCostUsd?: number;
  /** Agent turn deadline in ms. The function duration still caps it. */
  turnTimeoutMs?: number;
}

/** Runtime config that one app sets and a later app must not inherit. */
export interface RuntimeConfigSnapshot {
  bot: BotConfig;
  completedReactionEmoji: string;
  conversationWorkSoftYieldAfterMs: number;
  functionMaxDurationSeconds: number;
  processingReactionEmoji: string;
}

/** Copy the runtime config so a failed app setup can restore it. */
export function snapshotRuntimeConfig(): RuntimeConfigSnapshot {
  return {
    bot: { ...chatConfig.bot },
    completedReactionEmoji: chatConfig.slack.completedReactionEmoji,
    conversationWorkSoftYieldAfterMs:
      chatConfig.conversationWorkSoftYieldAfterMs,
    functionMaxDurationSeconds: chatConfig.functionMaxDurationSeconds,
    processingReactionEmoji: chatConfig.slack.processingReactionEmoji,
  };
}

/** Replace the runtime config with a snapshot. */
export function restoreRuntimeConfig(snapshot: RuntimeConfigSnapshot): void {
  replaceBotConfig(snapshot.bot);
  chatConfig.functionMaxDurationSeconds = snapshot.functionMaxDurationSeconds;
  chatConfig.conversationWorkSoftYieldAfterMs =
    snapshot.conversationWorkSoftYieldAfterMs;
  chatConfig.slack.completedReactionEmoji = snapshot.completedReactionEmoji;
  chatConfig.slack.processingReactionEmoji = snapshot.processingReactionEmoji;
}

/**
 * Reset bot, limit, and Slack settings to the environment defaults and apply
 * the host execution budget. Each app calls this before it applies options.
 */
export function resetRuntimeConfig(functionMaxDurationSeconds?: number): void {
  const resolved = resolveFunctionMaxDurationSeconds(
    functionMaxDurationSeconds,
  );
  chatConfig.functionMaxDurationSeconds = resolved;
  chatConfig.conversationWorkSoftYieldAfterMs =
    resolveConversationWorkSoftYieldAfterMs(resolved);
  replaceBotConfig(readChatConfig(process.env, resolved).bot);
  chatConfig.slack.completedReactionEmoji = DEFAULT_COMPLETED_REACTION_EMOJI;
  chatConfig.slack.processingReactionEmoji = DEFAULT_PROCESSING_REACTION_EMOJI;
}

// Readers hold `botConfig`, so replace its fields instead of the object.
function replaceBotConfig(next: BotConfig): void {
  for (const key of Object.keys(chatConfig.bot)) {
    delete (chatConfig.bot as Partial<BotConfig>)[key as keyof BotConfig];
  }
  Object.assign(chatConfig.bot, next);
}

function requirePositiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`limits.${name} must be a positive integer`);
  }
  return value;
}

/** Apply limits from createApp(). Unset limits keep their defaults. */
export function setRuntimeLimits(limits: RuntimeLimits | undefined): void {
  const bot = chatConfig.bot;
  if (limits?.contextWindowTokens !== undefined) {
    bot.contextWindowTokens = requirePositiveLimit(
      "contextWindowTokens",
      limits.contextWindowTokens,
    );
  }
  if (limits?.maxAgentDepth !== undefined) {
    if (
      !Number.isSafeInteger(limits.maxAgentDepth) ||
      limits.maxAgentDepth < 0
    ) {
      throw new Error("limits.maxAgentDepth must be a non-negative integer");
    }
    bot.maxAgentDepth = limits.maxAgentDepth;
  }
  if (limits?.maxConsecutiveAutomatedTurns !== undefined) {
    bot.maxConsecutiveAutomatedTurns = requirePositiveLimit(
      "maxConsecutiveAutomatedTurns",
      limits.maxConsecutiveAutomatedTurns,
    );
  }
  const runLimit = limits?.eventAutomationRunLimit;
  if (runLimit?.maxRuns !== undefined) {
    bot.maxEventAutomationRuns = requirePositiveLimit(
      "eventAutomationRunLimit.maxRuns",
      runLimit.maxRuns,
    );
  }
  if (runLimit?.windowMs !== undefined) {
    bot.eventAutomationRunWindowMs = requirePositiveLimit(
      "eventAutomationRunLimit.windowMs",
      runLimit.windowMs,
    );
  }
  if (limits?.maxSlicesPerTurn !== undefined) {
    bot.maxSlicesPerTurn = requirePositiveLimit(
      "maxSlicesPerTurn",
      limits.maxSlicesPerTurn,
    );
  }
  if (limits?.maxToolCallsPerTurn !== undefined) {
    bot.maxToolCallsPerTurn = requirePositiveLimit(
      "maxToolCallsPerTurn",
      limits.maxToolCallsPerTurn,
    );
  }
  if (limits?.maxTurnCostUsd !== undefined) {
    bot.maxTurnCostUsd = requirePositiveLimit(
      "maxTurnCostUsd",
      limits.maxTurnCostUsd,
    );
  }
  if (limits?.turnTimeoutMs !== undefined) {
    bot.turnTimeoutMs = Math.min(
      requirePositiveLimit("turnTimeoutMs", limits.turnTimeoutMs),
      resolveMaxTurnTimeoutMs(chatConfig.functionMaxDurationSeconds),
    );
  }
}

/** Return the chat configuration (parsed once at startup). */
export function getChatConfig(): ChatConfig {
  return chatConfig;
}

/** Bot configuration derived from environment at module load. */
export const botConfig: BotConfig = chatConfig.bot;

export function getSlackBotToken(): string | undefined {
  return chatConfig.slack.botToken;
}

export function getSlackSigningSecret(): string | undefined {
  return chatConfig.slack.signingSecret;
}

export function getSlackClientId(): string | undefined {
  return chatConfig.slack.clientId;
}

export function getSlackClientSecret(): string | undefined {
  return chatConfig.slack.clientSecret;
}

// ---------------------------------------------------------------------------
// Runtime metadata
// ---------------------------------------------------------------------------

export interface RuntimeMetadata {
  version?: string | undefined;
}

/** Return runtime metadata (version from deploy environment). */
export function getRuntimeMetadata(): RuntimeMetadata {
  return {
    version: toOptionalTrimmed(process.env["VERCEL_GIT_COMMIT_SHA"]),
  };
}

export interface SlackReactionConfig {
  completedReactionEmoji: string;
  processingReactionEmoji: string;
}

/** Apply model overrides from createApp(). */
export function setBotModelConfig(config: BotModelConfig): void {
  if (config.modelId !== undefined) {
    botConfig.modelId = requireModelId(
      "modelId",
      config.modelId,
      validateGatewayModelId,
    );
  }
  if (config.decisionModelId !== undefined) {
    botConfig.decisionModelId = requireModelId(
      "decisionModelId",
      config.decisionModelId,
      toOptionalTrimmed,
    );
  }
  if (config.embeddingModelId !== undefined) {
    botConfig.embeddingModelId = requireModelId(
      "embeddingModelId",
      config.embeddingModelId,
      validateEmbeddingModelId,
    );
  }
  if (config.fastModelId !== undefined) {
    botConfig.fastModelId = requireModelId(
      "fastModelId",
      config.fastModelId,
      validateGatewayModelId,
    );
  }
  if (config.guardianModelId !== undefined) {
    botConfig.guardianModelId = requireModelId(
      "guardianModelId",
      config.guardianModelId,
      validateGatewayModelId,
    );
  }
  if (config.rerankingModelId !== undefined) {
    botConfig.rerankingModelId = requireModelId(
      "rerankingModelId",
      config.rerankingModelId,
      toOptionalTrimmed,
    );
  }
  if (config.imageGenerationModelId !== undefined) {
    botConfig.imageGenerationModelId = requireModelId(
      "imageGenerationModelId",
      config.imageGenerationModelId,
      validateEmbeddingModelId,
    );
  }
  if (config.transcriptionModelId !== undefined) {
    botConfig.transcriptionModelId = requireModelId(
      "transcriptionModelId",
      config.transcriptionModelId,
      toOptionalTrimmed,
    );
  }
  if (config.visionModelId !== undefined) {
    botConfig.visionModelId = requireModelId(
      "visionModelId",
      config.visionModelId,
      validateGatewayModelId,
    );
  }
  if (config.refusalFallbackModelId !== undefined) {
    botConfig.refusalFallbackModelId = requireModelId(
      "refusalFallbackModelId",
      config.refusalFallbackModelId,
      validateGatewayModelId,
    );
  }
  if (config.webSearchModelId !== undefined) {
    botConfig.webSearchModelId = requireModelId(
      "webSearchModelId",
      config.webSearchModelId,
      validateGatewayModelId,
    );
  }
}

/**
 * Apply the bot name that a `juniorNitro()` build resolved, so the runtime
 * and the built system prompt use the same name. Without a build, the name
 * stays `JUNIOR_BOT_NAME`, then `junior`.
 */
export function setBotName(name: string | undefined): void {
  if (name === undefined) return;
  botConfig.userName = resolveBotName(name, process.env);
}

/** Return the current Slack reaction emoji config. */
export function getSlackReactionConfig(): SlackReactionConfig {
  return {
    completedReactionEmoji: chatConfig.slack.completedReactionEmoji,
    processingReactionEmoji: chatConfig.slack.processingReactionEmoji,
  };
}

/** Apply Slack reaction emoji overrides from createApp() options, validating names. */
export function setSlackReactionConfig(
  overrides: Partial<SlackReactionConfig>,
): void {
  if (overrides.processingReactionEmoji !== undefined) {
    chatConfig.slack.processingReactionEmoji = parseReactionEmoji(
      "processingReactionEmoji",
      overrides.processingReactionEmoji,
      chatConfig.slack.processingReactionEmoji,
    );
  }
  if (overrides.completedReactionEmoji !== undefined) {
    chatConfig.slack.completedReactionEmoji = parseReactionEmoji(
      "completedReactionEmoji",
      overrides.completedReactionEmoji,
      chatConfig.slack.completedReactionEmoji,
    );
  }
}
