import { getModel } from "@earendil-works/pi-ai/compat";
import { toOptionalTrimmed } from "@/chat/optional-string";
import { resolveGatewayModel } from "@/chat/pi/client";
import { normalizeSlackEmojiName } from "@/chat/slack/emoji";
import {
  parseTurnReasoningLevel,
  type TurnReasoningLevel,
} from "@/chat/reasoning-level";
import {
  DEFAULT_HANDOFF_MODEL_PROFILE,
  modelProfileSchema,
  STANDARD_MODEL_PROFILE,
} from "@/chat/model-profile";

const MIN_AGENT_TURN_TIMEOUT_MS = 10 * 1000;
const DEFAULT_AGENT_TURN_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_SLICES_PER_TURN = 100;
const DEFAULT_FUNCTION_MAX_DURATION_SECONDS = 300;
const DEFAULT_SLACK_SLASH_COMMAND = "/jr";
const DEFAULT_PROCESSING_REACTION_EMOJI = "eyes";
const DEFAULT_COMPLETED_REACTION_EMOJI = "white_check_mark";
/**
 * Buffer between the Vercel function timeout and the agent turn timeout so
 * Junior can abort, persist, and schedule continuation before host teardown.
 */
export const FUNCTION_TIMEOUT_BUFFER_SECONDS = 20;
const DEFAULT_ASSISTANT_LOADING_MESSAGES = [
  "Consulting the orb",
  "Bribing the gremlins",
  "Shuffling the papers dramatically",
  "Summoning the right stack trace",
  "Negotiating with the mutex",
  "Poking the internet with a stick",
  "Asking the docs nicely",
  "Searching for the least cursed path",
  "Pretending this was obvious",
  "Waking up the test suite",
  "Untangling the spaghetti carefully",
  "Rattling the command line",
] as const;

export interface BotConfig {
  embeddingModelId: string;
  fastModelId: string;
  loadingMessages: string[];
  modelId: string;
  modelProfiles: Readonly<Record<string, string>>;
  reasoningLevel?: TurnReasoningLevel;
  modelContextWindowTokens?: number;
  visionModelId?: string;
  maxSlicesPerTurn: number;
  turnTimeoutMs: number;
  userName: string;
}

export type SqlDriver = "neon" | "postgres";

export interface ChatConfig {
  bot: BotConfig;
  functionMaxDurationSeconds: number;
  sql: {
    databaseUrl: string;
    driver: SqlDriver;
  };
  slack: {
    botToken?: string;
    clientId?: string;
    clientSecret?: string;
    completedReactionEmoji: string;
    processingReactionEmoji: string;
    signingSecret?: string;
    slashCommand: string;
  };
  state: {
    adapter: "memory" | "redis";
    keyPrefix?: string;
    redisUrl?: string;
  };
}

function parseAgentTurnTimeoutMs(
  rawValue: string | undefined,
  maxTimeoutMs: number,
): number {
  const value = Number.parseInt(rawValue ?? "", 10);
  if (Number.isNaN(value)) {
    return Math.max(
      MIN_AGENT_TURN_TIMEOUT_MS,
      Math.min(DEFAULT_AGENT_TURN_TIMEOUT_MS, maxTimeoutMs),
    );
  }
  return Math.max(MIN_AGENT_TURN_TIMEOUT_MS, Math.min(value, maxTimeoutMs));
}

function resolveFunctionMaxDurationSeconds(env: NodeJS.ProcessEnv): number {
  const raw =
    env.FUNCTION_MAX_DURATION_SECONDS ??
    env.QUEUE_CALLBACK_MAX_DURATION_SECONDS;
  const value = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(value) || value <= 0) {
    return DEFAULT_FUNCTION_MAX_DURATION_SECONDS;
  }
  return value;
}

function resolveMaxTurnTimeoutMs(functionMaxDurationSeconds: number): number {
  const budgetSeconds =
    functionMaxDurationSeconds - FUNCTION_TIMEOUT_BUFFER_SECONDS;
  return Math.max(MIN_AGENT_TURN_TIMEOUT_MS, budgetSeconds * 1000);
}

function parseLoadingMessages(rawValue: string | undefined): string[] {
  const trimmed = rawValue?.trim();
  if (!trimmed) {
    return [...DEFAULT_ASSISTANT_LOADING_MESSAGES];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("JUNIOR_LOADING_MESSAGES must be a JSON array of strings");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("JUNIOR_LOADING_MESSAGES must be a JSON array of strings");
  }

  return parsed.map((value, index) => {
    if (typeof value !== "string") {
      throw new Error(`JUNIOR_LOADING_MESSAGES[${index}] must be a string`);
    }
    return value.trim();
  });
}

function parseOptionalPositiveInteger(
  envName: string,
  rawValue: string | undefined,
): number | undefined {
  const trimmed = toOptionalTrimmed(rawValue);
  if (trimmed === undefined) {
    return undefined;
  }

  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== trimmed) {
    throw new Error(`${envName} must be a positive integer`);
  }
  return value;
}

function parseSlashCommand(rawValue: string | undefined): string {
  const command = toOptionalTrimmed(rawValue) ?? DEFAULT_SLACK_SLASH_COMMAND;
  if (!command.startsWith("/") || /\s/.test(command)) {
    throw new Error(
      "JUNIOR_SLASH_COMMAND must start with / and contain no whitespace",
    );
  }
  return command;
}

// Compile-time assertion: `getModel`'s second generic is constrained to
// `keyof (typeof MODELS)[TProvider]`, so a stale default becomes a tsc error.
const DEFAULT_MODEL_ID = getModel("vercel-ai-gateway", "openai/gpt-5.5").id;
const DEFAULT_FAST_MODEL_ID = getModel(
  "vercel-ai-gateway",
  "openai/gpt-5.4-mini",
).id;
const DEFAULT_HANDOFF_MODEL_ID = getModel(
  "vercel-ai-gateway",
  "openai/gpt-5.6-sol",
).id;
const DEFAULT_EMBEDDING_MODEL_ID = "openai/text-embedding-3-small";

function validateGatewayModelId(raw: string | undefined): string | undefined {
  const trimmed = toOptionalTrimmed(raw);
  if (trimmed === undefined) return undefined;
  resolveGatewayModel(trimmed);
  return trimmed;
}

function validateEmbeddingModelId(raw: string | undefined): string | undefined {
  return toOptionalTrimmed(raw);
}

function parseModelProfiles(
  rawValue: string | undefined,
  handoffModelId: string,
): Readonly<Record<string, string>> {
  const profiles: Record<string, string> = {
    [DEFAULT_HANDOFF_MODEL_PROFILE]: handoffModelId,
  };
  const trimmed = toOptionalTrimmed(rawValue);
  if (trimmed === undefined) {
    return profiles;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("AI_MODEL_PROFILES must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI_MODEL_PROFILES must be a JSON object");
  }
  for (const [profile, rawModelId] of Object.entries(parsed)) {
    if (!modelProfileSchema.safeParse(profile).success) {
      throw new Error(
        `AI_MODEL_PROFILES profile "${profile}" must match ^[a-z][a-z0-9_-]*$`,
      );
    }
    if (
      profile === STANDARD_MODEL_PROFILE ||
      profile === DEFAULT_HANDOFF_MODEL_PROFILE
    ) {
      throw new Error(`AI_MODEL_PROFILES profile "${profile}" is reserved`);
    }
    if (typeof rawModelId !== "string") {
      throw new Error(`AI_MODEL_PROFILES.${profile} must be a model id string`);
    }
    const modelId = validateGatewayModelId(rawModelId);
    if (!modelId) {
      throw new Error(`AI_MODEL_PROFILES.${profile} must not be empty`);
    }
    profiles[profile] = modelId;
  }
  return profiles;
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

function readBotConfig(env: NodeJS.ProcessEnv): BotConfig {
  const functionMaxDurationSeconds = resolveFunctionMaxDurationSeconds(env);
  const maxTurnTimeoutMs = resolveMaxTurnTimeoutMs(functionMaxDurationSeconds);
  const modelId = validateGatewayModelId(env.AI_MODEL) ?? DEFAULT_MODEL_ID;
  const reasoningLevel = toOptionalTrimmed(env.AI_REASONING_LEVEL);
  const fastModelId =
    validateGatewayModelId(env.AI_FAST_MODEL ?? env.AI_MODEL) ??
    DEFAULT_FAST_MODEL_ID;
  const handoffModelId =
    validateGatewayModelId(env.AI_HANDOFF_MODEL) ?? DEFAULT_HANDOFF_MODEL_ID;

  return {
    userName: toOptionalTrimmed(env.JUNIOR_BOT_NAME) ?? "junior",
    modelId,
    modelProfiles: parseModelProfiles(env.AI_MODEL_PROFILES, handoffModelId),
    modelContextWindowTokens: parseOptionalPositiveInteger(
      "AI_MODEL_CONTEXT_WINDOW_TOKENS",
      env.AI_MODEL_CONTEXT_WINDOW_TOKENS,
    ),
    reasoningLevel:
      reasoningLevel === undefined
        ? undefined
        : parseTurnReasoningLevel(reasoningLevel),
    fastModelId,
    embeddingModelId:
      validateEmbeddingModelId(env.AI_EMBEDDING_MODEL) ??
      DEFAULT_EMBEDDING_MODEL_ID,
    loadingMessages: parseLoadingMessages(env.JUNIOR_LOADING_MESSAGES),
    visionModelId: validateGatewayModelId(env.AI_VISION_MODEL),
    maxSlicesPerTurn: MAX_SLICES_PER_TURN,
    turnTimeoutMs: parseAgentTurnTimeoutMs(
      env.AGENT_TURN_TIMEOUT_MS,
      maxTurnTimeoutMs,
    ),
  };
}

function readDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const databaseUrl = toOptionalTrimmed(env.DATABASE_URL);
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return databaseUrl;
}

function isLocalDatabaseUrl(databaseUrl: string): boolean {
  try {
    const { hostname } = new URL(databaseUrl);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function readSqlDriver(env: NodeJS.ProcessEnv, databaseUrl: string): SqlDriver {
  const value = toOptionalTrimmed(env.JUNIOR_DATABASE_DRIVER);
  if (value === undefined) {
    if (isLocalDatabaseUrl(databaseUrl)) {
      return "postgres";
    }
    return "neon";
  }
  if (value === "neon" || value === "postgres") {
    return value;
  }
  throw new Error("JUNIOR_DATABASE_DRIVER must be postgres or neon");
}

/** Parse all chat configuration from environment variables. */
export function readChatConfig(
  env: NodeJS.ProcessEnv = process.env,
): ChatConfig {
  const databaseUrl = readDatabaseUrl(env);
  return {
    bot: readBotConfig(env),
    functionMaxDurationSeconds: resolveFunctionMaxDurationSeconds(env),
    sql: {
      databaseUrl,
      driver: readSqlDriver(env, databaseUrl),
    },
    slack: {
      botToken:
        toOptionalTrimmed(env.SLACK_BOT_TOKEN) ??
        toOptionalTrimmed(env.SLACK_BOT_USER_TOKEN),
      clientId: toOptionalTrimmed(env.SLACK_CLIENT_ID),
      clientSecret: toOptionalTrimmed(env.SLACK_CLIENT_SECRET),
      completedReactionEmoji: DEFAULT_COMPLETED_REACTION_EMOJI,
      processingReactionEmoji: DEFAULT_PROCESSING_REACTION_EMOJI,
      signingSecret: toOptionalTrimmed(env.SLACK_SIGNING_SECRET),
      slashCommand: parseSlashCommand(env.JUNIOR_SLASH_COMMAND),
    },
    state: {
      adapter:
        env.JUNIOR_STATE_ADAPTER?.trim().toLowerCase() === "memory"
          ? "memory"
          : "redis",
      keyPrefix: toOptionalTrimmed(env.JUNIOR_STATE_KEY_PREFIX),
      redisUrl: toOptionalTrimmed(env.REDIS_URL),
    },
  };
}

/** Chat configuration parsed once at module load from the process environment. */
const chatConfig: ChatConfig = readChatConfig(process.env);

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

export function hasRedisConfig(): boolean {
  return Boolean(chatConfig.state.redisUrl);
}

// ---------------------------------------------------------------------------
// Runtime metadata
// ---------------------------------------------------------------------------

export interface RuntimeMetadata {
  version?: string;
}

/** Return runtime metadata (version from deploy environment). */
export function getRuntimeMetadata(): RuntimeMetadata {
  return {
    version: toOptionalTrimmed(process.env.VERCEL_GIT_COMMIT_SHA),
  };
}

export interface SlackReactionConfig {
  completedReactionEmoji: string;
  processingReactionEmoji: string;
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
