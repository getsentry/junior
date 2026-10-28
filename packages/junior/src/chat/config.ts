import { toOptionalTrimmed } from "@/chat/optional-string";
import { resolveGatewayModel } from "@/chat/pi/client";
import { normalizeSlackEmojiName } from "@/chat/slack/emoji";
import { logWarn } from "@/chat/logging";
import {
  parseTurnReasoningLevel,
  TURN_REASONING_LEVELS,
  type TurnReasoningLevel,
} from "@/chat/reasoning-level";
import {
  DEFAULT_MODEL_PROFILES,
  type ModelProfileConfig,
  type ModelProfile,
  type ModelProfileInput,
  modelProfileSchema,
} from "@/chat/model-profile";

const MIN_AGENT_TURN_TIMEOUT_MS = 10 * 1000;
const DEFAULT_AGENT_TURN_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_SLICES_PER_TURN = 100;
/**
 * Max model spend in USD for one turn, including later execution slices of
 * that turn. Sentry span estimates put a child agent that made 250 tool calls
 * of real work at about $50.
 */
const MAX_TURN_COST_USD = 100;
/**
 * Max tool calls for one turn, including later execution slices of that turn.
 * A backstop for models without cost data. The spend limit should stop a turn
 * first. 250 calls stopped child agents that were still doing real work.
 */
const MAX_TOOL_CALLS_PER_TURN = 1000;
/**
 * Max consecutive automated turns before event wakes stop until a user message.
 * Resource-event CI watches and event-automation loops are the common runaway paths.
 * Sentry telemetry has no direct instrumentation for how long real automated
 * chains run (only failure paths on the notice are logged, and those show zero
 * hits in the last 30d), so this is sized qualitatively: it stays well under
 * the runaway CI-watch-loop range (hundreds of tool calls) while giving
 * multi-phase event-automation/scheduled-automation work enough headroom to
 * avoid pausing on legitimate longer-running automation.
 */
const MAX_CONSECUTIVE_AUTOMATED_TURNS = 25;
/**
 * Max runs one Event automation can start in one rolling run window. Each run
 * is a full agent turn, and Event automations skip the consecutive
 * automated-turn limit. Kept low so a broad trigger, such as every message in
 * a channel, blocks quickly instead of starting a turn for each Event.
 */
const MAX_EVENT_AUTOMATION_RUNS = 10;
/** Length of the rolling window for the Event automation run limit. */
const EVENT_AUTOMATION_RUN_WINDOW_MS = 60 * 1000;
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

export interface BotModelConfig {
  /** Decision model used by the passive reply router. */
  decisionModelId?: string;
  /** Model used for embeddings. */
  embeddingModelId?: string;
  /** Model used for low-cost structured and utility calls. */
  fastModelId?: string;
  /** Decision model used to review sensitive tool calls. */
  guardianModelId?: string;
  /** Model used to generate images. */
  imageGenerationModelId?: string;
  /** Model used to analyze images. */
  visionModelId?: string;
  /** Model used for web search. */
  webSearchModelId?: string;
}

export interface BotConfig {
  contextWindowTokens: number;
  crossActorMidRunMode: CrossActorMidRunMode;
  decisionModelId: string;
  defaultProfile: ModelProfile;
  embeddingModelId: string;
  fastModelId: string;
  guardianModelId: string;
  imageGenerationModelId: string;
  loadingMessages: string[];
  profiles: Readonly<Record<string, ModelProfileConfig>>;
  reasoningLevel?: TurnReasoningLevel;
  visionModelId?: string;
  maxAgentDepth: number;
  maxSlicesPerTurn: number;
  maxToolCallsPerTurn: number;
  maxTurnCostUsd: number;
  maxConsecutiveAutomatedTurns: number;
  maxEventAutomationRuns: number;
  eventAutomationRunWindowMs: number;
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

const DEFAULT_MODEL_ID = resolveGatewayModel(
  DEFAULT_MODEL_PROFILES.standard.modelId,
).id;
const DEFAULT_FAST_MODEL_ID = resolveGatewayModel("openai/gpt-6-luna").id;
const DEFAULT_GUARDIAN_MODEL_ID = "typesafe-ai/jev";
const DEFAULT_HANDOFF_MODEL_ID = resolveGatewayModel(
  DEFAULT_MODEL_PROFILES.handoff.modelId,
).id;
const DEFAULT_WEB_SEARCH_MODEL_ID = resolveGatewayModel("openai/gpt-6-luna").id;
const DEFAULT_DECISION_MODEL_ID = "typesafe-ai/jev";
const DEFAULT_EMBEDDING_MODEL_ID = "openai/text-embedding-3-small";
const DEFAULT_IMAGE_GENERATION_MODEL_ID = "google/gemini-3-pro-image";
const DEFAULT_VISION_MODEL_ID = resolveGatewayModel("openai/gpt-5.6-sol").id;

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

function parseOptionalProfileDescription(
  rawDescription: unknown,
  configName: string,
  profile: string,
): string | undefined {
  if (rawDescription === undefined) {
    return undefined;
  }
  if (typeof rawDescription !== "string") {
    throw new Error(
      `${configName}.${profile}.description must be a string when set`,
    );
  }
  const description = toOptionalTrimmed(rawDescription);
  if (!description) {
    throw new Error(
      `${configName}.${profile}.description must not be empty when set`,
    );
  }
  return description;
}

function parseOptionalProfileReasoningLevel(
  rawReasoningLevel: unknown,
  configName: string,
  profile: string,
): TurnReasoningLevel | undefined {
  if (rawReasoningLevel === undefined) {
    return undefined;
  }
  try {
    return parseTurnReasoningLevel(rawReasoningLevel);
  } catch {
    throw new Error(
      `${configName}.${profile}.reasoningLevel must be one of ${TURN_REASONING_LEVELS.join(", ")}`,
    );
  }
}

function parseProfileConfig(
  rawProfile: unknown,
  configName: string,
  profile: string,
): ModelProfileConfig {
  if (typeof rawProfile === "string") {
    const modelId = validateGatewayModelId(rawProfile);
    if (!modelId) {
      throw new Error(`${configName}.${profile} must not be empty`);
    }
    return { modelId };
  }

  if (
    !rawProfile ||
    typeof rawProfile !== "object" ||
    Array.isArray(rawProfile)
  ) {
    throw new Error(
      `${configName}.${profile} must be a model id string or an object with modelId`,
    );
  }

  const rawModelId = (rawProfile as { modelId?: unknown }).modelId;
  if (typeof rawModelId !== "string") {
    throw new Error(
      `${configName}.${profile}.modelId must be a model id string`,
    );
  }
  const modelId = validateGatewayModelId(rawModelId);
  if (!modelId) {
    throw new Error(`${configName}.${profile}.modelId must not be empty`);
  }

  const description = parseOptionalProfileDescription(
    (rawProfile as { description?: unknown }).description,
    configName,
    profile,
  );
  const reasoningLevel = parseOptionalProfileReasoningLevel(
    (rawProfile as { reasoningLevel?: unknown }).reasoningLevel,
    configName,
    profile,
  );

  return {
    modelId,
    ...(description ? { description } : undefined),
    ...(reasoningLevel ? { reasoningLevel } : undefined),
  };
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
  for (const [profile, rawProfile] of Object.entries(rawProfiles)) {
    if (!modelProfileSchema.safeParse(profile).success) {
      throw new Error(
        `${configName} profile "${profile}" must match ^[a-z][a-z0-9_-]*$`,
      );
    }
    profiles[profile] = parseProfileConfig(rawProfile, configName, profile);
  }
  return profiles;
}

// TODO(dcramer): Remove env profile settings after supported deployments no
// longer use AI_MODEL, AI_HANDOFF_MODEL, or AI_MODEL_PROFILES.
function parseProfiles(
  rawValue: string | undefined,
  standardModelId: string,
  handoffModelId: string,
): Readonly<Record<string, ModelProfileConfig>> {
  const profiles: Record<string, ModelProfileConfig> = {
    standard: {
      ...DEFAULT_MODEL_PROFILES.standard,
      modelId: standardModelId,
    },
    handoff: {
      ...DEFAULT_MODEL_PROFILES.handoff,
      modelId: handoffModelId,
    },
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
  const maxTurnTimeoutMs = resolveMaxTurnTimeoutMs(functionMaxDurationSeconds);
  const modelId = validateGatewayModelId(env.AI_MODEL) ?? DEFAULT_MODEL_ID;
  const reasoningLevel = toOptionalTrimmed(env.AI_REASONING_LEVEL);
  const fastModelId =
    validateGatewayModelId(env.AI_FAST_MODEL ?? env.AI_MODEL) ??
    DEFAULT_FAST_MODEL_ID;
  const guardianModelId =
    toOptionalTrimmed(env.AI_GUARDIAN_MODEL) ?? DEFAULT_GUARDIAN_MODEL_ID;
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
    decisionModelId:
      toOptionalTrimmed(env.AI_DECISION_MODEL) ?? DEFAULT_DECISION_MODEL_ID,
    fastModelId,
    guardianModelId,
    imageGenerationModelId:
      toOptionalTrimmed(env.AI_IMAGE_MODEL) ??
      DEFAULT_IMAGE_GENERATION_MODEL_ID,
    embeddingModelId:
      validateEmbeddingModelId(env.AI_EMBEDDING_MODEL) ??
      DEFAULT_EMBEDDING_MODEL_ID,
    loadingMessages: parseLoadingMessages(env.JUNIOR_LOADING_MESSAGES),
    visionModelId:
      env.AI_VISION_MODEL === undefined
        ? DEFAULT_VISION_MODEL_ID
        : validateGatewayModelId(env.AI_VISION_MODEL),
    maxAgentDepth: 0,
    maxSlicesPerTurn: MAX_SLICES_PER_TURN,
    maxToolCallsPerTurn: MAX_TOOL_CALLS_PER_TURN,
    maxTurnCostUsd: MAX_TURN_COST_USD,
    maxConsecutiveAutomatedTurns: MAX_CONSECUTIVE_AUTOMATED_TURNS,
    maxEventAutomationRuns: MAX_EVENT_AUTOMATION_RUNS,
    eventAutomationRunWindowMs: EVENT_AUTOMATION_RUN_WINDOW_MS,
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
  warnDeprecatedProfileEnv(env);
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

/** Limits a host can set with `createApp({ limits })`. */
export interface RuntimeLimits {
  /** Largest model context window used for compaction, in tokens. */
  contextWindowTokens?: number;
  /**
   * Levels of child agents that can start their own child agents. The
   * default, 0, lets only the root Conversation start child agents.
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
  replaceBotConfig(readBotConfig(process.env, resolved));
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

/** Apply the Slack cross-actor steering mode from createApp(). */
export function setCrossActorMidRunMode(mode: CrossActorMidRunMode): void {
  chatConfig.bot.crossActorMidRunMode = parseCrossActorMidRunMode(mode);
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

/** Apply model overrides from createApp(). */
export function setBotModelConfig(config: BotModelConfig): void {
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
  if (config.visionModelId !== undefined) {
    botConfig.visionModelId = requireModelId(
      "visionModelId",
      config.visionModelId,
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

/** Apply profiles from createApp(). */
export function setProfiles(
  profiles: Readonly<Record<string, ModelProfileInput>> | undefined,
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
