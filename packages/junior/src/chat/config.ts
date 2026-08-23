import { getModel } from "@earendil-works/pi-ai/compat";
import { toOptionalTrimmed } from "@/chat/optional-string";
import { resolveGatewayModel } from "@/chat/pi/client";
import { normalizeSlackEmojiName } from "@/chat/slack/emoji";
import { logWarn } from "@/chat/logging";
import {
  parseTurnReasoningLevel,
  type TurnReasoningLevel,
} from "@/chat/reasoning-level";
import {
  type ModelProfileConfig,
  type ModelProfile,
  modelProfileSchema,
} from "@/chat/model-profile";

const MIN_AGENT_TURN_TIMEOUT_MS = 10 * 1000;
const DEFAULT_AGENT_TURN_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_SLICES_PER_TURN = 100;
const DEFAULT_FUNCTION_MAX_DURATION_SECONDS = 300;
const DEFAULT_SLACK_SLASH_COMMAND = "/jr";
const DEFAULT_PROCESSING_REACTION_EMOJI = "eyes";
const DEFAULT_COMPLETED_REACTION_EMOJI = "white_check_mark";
const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 400_000;
export const DEFAULT_SQL_STATEMENT_TIMEOUT_MS = 30_000;
/**
 * Buffer between the Vercel function timeout and the agent turn timeout so
 * Junior can abort, persist, and schedule continuation before host teardown.
 */
export const FUNCTION_TIMEOUT_BUFFER_SECONDS = 20;
/** Additional buffer that makes conversation work yield before the hard request deadline. */
export const CONVERSATION_WORK_SOFT_YIELD_BUFFER_SECONDS = 40;
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
  contextWindowTokens: number;
  crossActorMidRunMode: CrossActorMidRunMode;
  defaultProfile: ModelProfile;
  embeddingModelId: string;
  fastModelId: string;
  guardianModelId: string;
  imageGenerationModelId: string;
  loadingMessages: string[];
  profiles: Readonly<Record<string, ModelProfileConfig>>;
  reasoningLevel?: TurnReasoningLevel;
  visionModelId?: string;
  maxSlicesPerTurn: number;
  turnTimeoutMs: number;
  userName: string;
  webSearchModelId: string;
}

export type CrossActorMidRunMode = "follow_up" | "steer";

export type SqlDriver = "neon" | "postgres";

export interface ChatConfig {
  bot: BotConfig;
  functionMaxDurationSeconds: number;
  conversationWorkEnabled: boolean;
  conversationWorkSoftYieldAfterMs: number;
  sql: {
    databaseUrl: string;
    driver: SqlDriver;
    statementTimeoutMs: number | false;
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

function resolveFunctionMaxDurationSeconds(
  functionMaxDurationSeconds?: number,
): number {
  return functionMaxDurationSeconds ?? DEFAULT_FUNCTION_MAX_DURATION_SECONDS;
}

function resolveConversationWorkSoftYieldAfterMs(
  functionMaxDurationSeconds: number,
): number {
  return Math.max(
    MIN_AGENT_TURN_TIMEOUT_MS,
    (functionMaxDurationSeconds - CONVERSATION_WORK_SOFT_YIELD_BUFFER_SECONDS) *
      1000,
  );
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

function parseConversationWorkEnabled(rawValue: string | undefined): boolean {
  const value = toOptionalTrimmed(rawValue)?.toLowerCase();
  if (value === undefined || value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error("JUNIOR_CONVERSATION_WORK_ENABLED must be true or false");
}

function parseCrossActorMidRunMode(
  rawValue: string | undefined,
): CrossActorMidRunMode {
  const value = toOptionalTrimmed(rawValue) ?? "follow_up";
  if (value === "follow_up" || value === "steer") {
    return value;
  }
  throw new Error("JUNIOR_CROSS_ACTOR_MID_RUN_MODE must be follow_up or steer");
}

// Compile-time assertion: `getModel`'s second generic is constrained to
// `keyof (typeof MODELS)[TProvider]`, so a stale default becomes a tsc error.
const DEFAULT_MODEL_ID = getModel("vercel-ai-gateway", "xai/grok-4.5").id;
const DEFAULT_FAST_MODEL_ID = getModel(
  "vercel-ai-gateway",
  "anthropic/claude-haiku-4.5",
).id;
const DEFAULT_GUARDIAN_MODEL_ID = getModel(
  "vercel-ai-gateway",
  "openai/gpt-5.6-luna",
).id;
const DEFAULT_HANDOFF_MODEL_ID = getModel(
  "vercel-ai-gateway",
  "openai/gpt-5.6-sol",
).id;
const DEFAULT_WEB_SEARCH_MODEL_ID = getModel(
  "vercel-ai-gateway",
  "openai/gpt-5.4",
).id;
const DEFAULT_EMBEDDING_MODEL_ID = "openai/text-embedding-3-small";
const DEFAULT_IMAGE_GENERATION_MODEL_ID = "google/gemini-3-pro-image";

function validateGatewayModelId(raw: string | undefined): string | undefined {
  const trimmed = toOptionalTrimmed(raw);
  if (trimmed === undefined) return undefined;
  resolveGatewayModel(trimmed);
  return trimmed;
}

function validateEmbeddingModelId(raw: string | undefined): string | undefined {
  return toOptionalTrimmed(raw);
}

function parseProfileMap(
  rawProfiles: unknown,
  configName: string,
): Readonly<Record<string, ModelProfileConfig>> {
  if (
    !rawProfiles ||
    typeof rawProfiles !== "object" ||
    Array.isArray(rawProfiles)
  ) {
    const objectType =
      configName === "AI_MODEL_PROFILES" ? "a JSON object" : "an object";
    throw new Error(`${configName} must be ${objectType}`);
  }
  const profiles: Record<string, ModelProfileConfig> = {};
  for (const [profile, rawModelId] of Object.entries(rawProfiles)) {
    if (!modelProfileSchema.safeParse(profile).success) {
      throw new Error(
        `${configName} profile "${profile}" must match ^[a-z][a-z0-9_-]*$`,
      );
    }
    if (typeof rawModelId !== "string") {
      throw new Error(`${configName}.${profile} must be a model id string`);
    }
    const modelId = validateGatewayModelId(rawModelId);
    if (!modelId) {
      throw new Error(`${configName}.${profile} must not be empty`);
    }
    profiles[profile] = { modelId };
  }
  return profiles;
}

// TODO(v0.180.0): Remove env profile settings after the deprecation window.
function parseProfiles(
  rawValue: string | undefined,
  standardModelId: string,
  handoffModelId: string,
): Readonly<Record<string, ModelProfileConfig>> {
  const profiles: Record<string, ModelProfileConfig> = {
    standard: { modelId: standardModelId },
    handoff: { modelId: handoffModelId, reasoningLevel: "high" },
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
  return {
    ...profiles,
    ...parseProfileMap(parsed, "AI_MODEL_PROFILES"),
  };
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

function warnDeprecatedProfileEnv(env: NodeJS.ProcessEnv): void {
  for (const envName of [
    "AI_MODEL",
    "AI_HANDOFF_MODEL",
    "AI_MODEL_PROFILES",
  ] as const) {
    if (toOptionalTrimmed(env[envName]) !== undefined) {
      logWarn("config.profile_env.deprecated", {
        "app.config.env_name": envName,
        "app.config.replacement": "createApp({ defaultProfile, profiles })",
      });
    }
  }
}

function readBotConfig(
  env: NodeJS.ProcessEnv,
  functionMaxDurationSeconds: number,
): BotConfig {
  warnDeprecatedProfileEnv(env);
  const maxTurnTimeoutMs = resolveMaxTurnTimeoutMs(functionMaxDurationSeconds);
  const modelId = validateGatewayModelId(env.AI_MODEL) ?? DEFAULT_MODEL_ID;
  const reasoningLevel = toOptionalTrimmed(env.AI_REASONING_LEVEL);
  const fastModelId =
    validateGatewayModelId(env.AI_FAST_MODEL ?? env.AI_MODEL) ??
    DEFAULT_FAST_MODEL_ID;
  const guardianModelId =
    validateGatewayModelId(env.AI_GUARDIAN_MODEL) ?? DEFAULT_GUARDIAN_MODEL_ID;
  const handoffModelId =
    validateGatewayModelId(env.AI_HANDOFF_MODEL) ?? DEFAULT_HANDOFF_MODEL_ID;

  return {
    userName: toOptionalTrimmed(env.JUNIOR_BOT_NAME) ?? "junior",
    defaultProfile: "standard",
    crossActorMidRunMode: parseCrossActorMidRunMode(
      env.JUNIOR_CROSS_ACTOR_MID_RUN_MODE,
    ),
    profiles: parseProfiles(env.AI_MODEL_PROFILES, modelId, handoffModelId),
    contextWindowTokens:
      parseOptionalPositiveInteger(
        "AI_MODEL_CONTEXT_WINDOW_TOKENS",
        env.AI_MODEL_CONTEXT_WINDOW_TOKENS,
      ) ?? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
    reasoningLevel:
      reasoningLevel === undefined
        ? undefined
        : parseTurnReasoningLevel(reasoningLevel),
    fastModelId,
    guardianModelId,
    imageGenerationModelId:
      toOptionalTrimmed(env.AI_IMAGE_MODEL) ??
      DEFAULT_IMAGE_GENERATION_MODEL_ID,
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
    webSearchModelId:
      validateGatewayModelId(env.AI_WEB_SEARCH_MODEL) ??
      DEFAULT_WEB_SEARCH_MODEL_ID,
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

function readSqlStatementTimeoutMs(env: NodeJS.ProcessEnv): number | false {
  const rawValue = toOptionalTrimmed(env.JUNIOR_SQL_STATEMENT_TIMEOUT_MS);
  if (rawValue === undefined) {
    return DEFAULT_SQL_STATEMENT_TIMEOUT_MS;
  }
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== rawValue) {
    throw new Error(
      "JUNIOR_SQL_STATEMENT_TIMEOUT_MS must be a non-negative integer",
    );
  }
  return value === 0 ? false : value;
}

/** Parse all chat configuration from environment variables. */
export function readChatConfig(
  env: NodeJS.ProcessEnv = process.env,
  functionMaxDurationSeconds = DEFAULT_FUNCTION_MAX_DURATION_SECONDS,
): ChatConfig {
  const databaseUrl = readDatabaseUrl(env);
  const resolvedFunctionMaxDurationSeconds = resolveFunctionMaxDurationSeconds(
    functionMaxDurationSeconds,
  );
  return {
    bot: readBotConfig(env, resolvedFunctionMaxDurationSeconds),
    functionMaxDurationSeconds: resolvedFunctionMaxDurationSeconds,
    conversationWorkEnabled: parseConversationWorkEnabled(
      env.JUNIOR_CONVERSATION_WORK_ENABLED,
    ),
    conversationWorkSoftYieldAfterMs: resolveConversationWorkSoftYieldAfterMs(
      resolvedFunctionMaxDurationSeconds,
    ),
    sql: {
      databaseUrl,
      driver: readSqlDriver(env, databaseUrl),
      statementTimeoutMs: readSqlStatementTimeoutMs(env),
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

/** Apply the host execution budget injected by juniorNitro(). */
export function configureFunctionMaxDurationSeconds(
  functionMaxDurationSeconds: number,
): void {
  const resolved = resolveFunctionMaxDurationSeconds(
    functionMaxDurationSeconds,
  );
  chatConfig.functionMaxDurationSeconds = resolved;
  chatConfig.conversationWorkSoftYieldAfterMs =
    resolveConversationWorkSoftYieldAfterMs(resolved);
  chatConfig.bot.turnTimeoutMs = parseAgentTurnTimeoutMs(
    process.env.AGENT_TURN_TIMEOUT_MS,
    resolveMaxTurnTimeoutMs(resolved),
  );
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

/** Apply profiles from createApp(). */
export function setProfiles(
  profiles: Readonly<Record<string, string>> | undefined,
  defaultProfile: string | undefined,
): void {
  if (!profiles || !defaultProfile) {
    throw new Error("profiles and defaultProfile must be configured together");
  }
  const configuredProfiles = parseProfileMap(profiles, "profiles");
  const selectedDefault = defaultProfile;
  if (!modelProfileSchema.safeParse(selectedDefault).success) {
    throw new Error(
      `defaultProfile "${selectedDefault}" must match ^[a-z][a-z0-9_-]*$`,
    );
  }
  if (!Object.hasOwn(configuredProfiles, selectedDefault)) {
    throw new Error(`defaultProfile "${selectedDefault}" is not configured`);
  }
  botConfig.profiles = configuredProfiles;
  botConfig.defaultProfile = selectedDefault;
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
