import { loadConfig, type JuniorConfig } from "@/config";

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

/** Parse all chat configuration from environment variables. */
export function readChatConfig(
  env: NodeJS.ProcessEnv = process.env,
  functionMaxDurationSeconds?: number,
): ChatConfig {
  return loadConfig({ env, options: { functionMaxDurationSeconds } });
}

/** Limits a host can set with `createApp({ limits })`. */
export interface RuntimeLimits {
  /** Largest model context window used for compaction, in tokens. */
  contextWindowTokens?: number;
  /**
   * Levels of child agents that can start their own child agents. The
   * default, 2, lets a child of the root and its children start child
   * agents. 0 lets only the root Conversation start them.
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

let installed: ChatConfig | undefined;

/**
 * Return the config that createApp installed. Without one, such as in the
 * CLI, load it from `process.env` on the first read and keep it.
 */
export function getChatConfig(): ChatConfig {
  installed ??= loadConfig({ env: process.env });
  return installed;
}

/**
 * Install the config that createApp resolved. Returns the previous config,
 * so a failed startup can install it again. `undefined` loads from env again
 * on the next read.
 */
export function installChatConfig(
  config: ChatConfig | undefined,
): ChatConfig | undefined {
  const previous = installed;
  installed = config;
  return previous;
}

function isBotConfigKey(
  bot: BotConfig,
  key: string | symbol,
): key is keyof BotConfig {
  return Object.hasOwn(bot, key);
}

/**
 * Bot settings of the current config. Readers keep this object, so it
 * forwards every read and write to `getChatConfig().bot`.
 *
 * Temporary: callers read `botConfig` as a plain property, so lazy loading
 * needs a read trap. Remove this Proxy once config is passed in explicitly.
 */
export const botConfig: BotConfig = new Proxy({} as BotConfig, {
  defineProperty: (_, key, descriptor) =>
    Reflect.defineProperty(getChatConfig().bot, key, descriptor),
  deleteProperty: (_, key) => Reflect.deleteProperty(getChatConfig().bot, key),
  get: (_, key) => {
    const bot = getChatConfig().bot;
    return isBotConfigKey(bot, key) ? bot[key] : undefined;
  },
  getOwnPropertyDescriptor: (_, key) =>
    Reflect.getOwnPropertyDescriptor(getChatConfig().bot, key),
  has: (_, key) => Reflect.has(getChatConfig().bot, key),
  ownKeys: () => Reflect.ownKeys(getChatConfig().bot),
  set: (_, key, value) => Reflect.set(getChatConfig().bot, key, value),
});

export function getSlackBotToken(): string | undefined {
  return getChatConfig().slack.botToken;
}

export function getSlackSigningSecret(): string | undefined {
  return getChatConfig().slack.signingSecret;
}

export function getSlackClientId(): string | undefined {
  return getChatConfig().slack.clientId;
}

export function getSlackClientSecret(): string | undefined {
  return getChatConfig().slack.clientSecret;
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
    version: getChatConfig().deployment.commitSha,
  };
}

export interface SlackReactionConfig {
  completedReactionEmoji: string;
  processingReactionEmoji: string;
}

/** Return the current Slack reaction emoji config. */
export function getSlackReactionConfig(): SlackReactionConfig {
  return {
    completedReactionEmoji: getChatConfig().slack.completedReactionEmoji,
    processingReactionEmoji: getChatConfig().slack.processingReactionEmoji,
  };
}
