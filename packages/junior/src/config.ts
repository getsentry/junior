import * as z from "zod";
import { toOptionalTrimmed } from "@/chat/optional-string";
import { resolveGatewayModel } from "@/chat/pi/client";
import {
  parseTurnReasoningLevel,
  TURN_REASONING_LEVELS,
} from "@/chat/reasoning-level";

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
export const DEFAULT_FUNCTION_MAX_DURATION_SECONDS = 300;
export const DEFAULT_PROCESSING_REACTION_EMOJI = "eyes";
export const DEFAULT_COMPLETED_REACTION_EMOJI = "white_check_mark";
const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 400_000;
export const DEFAULT_SQL_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_S3_REGION = "us-east-1";
const ENCRYPTION_KEY_BYTES = 32;
const ENCRYPTION_KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const ENCRYPTION_KEY_MATERIAL_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;
const ENCRYPTION_KEYS_HINT =
  "Generate a key with: " +
  `node -e "console.log('k1:' + require('node:crypto').randomBytes(32).toString('base64url'))"`;
/**
 * Buffer between the Vercel function timeout and the agent turn timeout so
 * Junior can abort, persist, and schedule continuation before host teardown.
 */
export const FUNCTION_TIMEOUT_BUFFER_SECONDS = 20;
/** Additional buffer that makes conversation work yield before the hard request deadline. */
const CONVERSATION_WORK_SOFT_YIELD_BUFFER_SECONDS = 40;
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

const DEFAULT_MODEL_ID = resolveGatewayModel("anthropic/claude-opus-5.5").id;
const DEFAULT_FAST_MODEL_ID = resolveGatewayModel("openai/gpt-6-luna").id;
const DEFAULT_GUARDIAN_MODEL_ID = resolveGatewayModel("openai/gpt-6-luna").id;
const DEFAULT_WEB_SEARCH_MODEL_ID = resolveGatewayModel("openai/gpt-6-luna").id;
const DEFAULT_DECISION_MODEL_ID = "typesafe-ai/jev";
const DEFAULT_EMBEDDING_MODEL_ID = "openai/text-embedding-3-small";
const DEFAULT_RERANKING_MODEL_ID = "voyage/rerank-2.5-lite";
const DEFAULT_IMAGE_GENERATION_MODEL_ID = "openai/gpt-image-2";
// The transcription tool sends a URL, not bytes. The model must accept
// ElevenLabs `sourceUrl`.
const DEFAULT_TRANSCRIPTION_MODEL_ID = "elevenlabs/scribe-v2";
const DEFAULT_VISION_MODEL_ID = resolveGatewayModel("openai/gpt-5.6-sol").id;

/** Longest agent turn the function duration allows, after the teardown buffer. */
export function resolveMaxTurnTimeoutMs(
  functionMaxDurationSeconds: number,
): number {
  const budgetSeconds =
    functionMaxDurationSeconds - FUNCTION_TIMEOUT_BUFFER_SECONDS;
  return Math.max(MIN_AGENT_TURN_TIMEOUT_MS, budgetSeconds * 1000);
}

/** When conversation work yields, so it stops before the request deadline. */
export function resolveConversationWorkSoftYieldAfterMs(
  functionMaxDurationSeconds: number,
): number {
  return Math.max(
    MIN_AGENT_TURN_TIMEOUT_MS,
    (functionMaxDurationSeconds - CONVERSATION_WORK_SOFT_YIELD_BUFFER_SECONDS) *
      1000,
  );
}

function isHttpUrl(value: string): boolean {
  const protocol = URL.parse(value)?.protocol;
  return protocol === "http:" || protocol === "https:";
}

// A key is 32 random bytes in base64 or base64url.
function isEncryptionKeyMaterial(material: string): boolean {
  return (
    ENCRYPTION_KEY_MATERIAL_PATTERN.test(material) &&
    Buffer.from(material, "base64").length === ENCRYPTION_KEY_BYTES
  );
}

const nonEmptyString = z.string().trim().min(1);
// `resolveGatewayModel` throws its own error for an unknown id, and that error
// leaves `safeParse` unchanged.
const gatewayModelId = nonEmptyString.refine((id) =>
  Boolean(resolveGatewayModel(id)),
);
const positiveInt = z.number().int().positive();

const s3StorageSchema = z.strictObject({
  accessKeyId: nonEmptyString,
  bucket: nonEmptyString,
  /** Base URL of the S3 API. Objects use path-style URLs under it. */
  endpoint: nonEmptyString,
  region: nonEmptyString.default(DEFAULT_S3_REGION),
  secretAccessKey: nonEmptyString,
});

const attachmentStorageSchema = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal("vercel-blob") }),
  z.strictObject({ provider: z.literal("s3"), s3: s3StorageSchema }),
  z.strictObject({ provider: z.literal("memory") }),
]);

const encryptionSchema = z
  .strictObject({
    /** Key for new values. */
    activeKeyId: z.string(),
    /** Every key that decrypts, as base64 key material. */
    keys: z
      .array(
        z.strictObject({
          id: z.string().regex(ENCRYPTION_KEY_ID_PATTERN),
          key: z
            .string()
            .refine(
              isEncryptionKeyMaterial,
              `must be ${ENCRYPTION_KEY_BYTES} bytes in base64`,
            ),
        }),
      )
      .min(1),
  })
  .refine(
    ({ keys }) => new Set(keys.map(({ id }) => id)).size === keys.length,
    { message: "must not repeat a key id", path: ["keys"] },
  )
  .refine(
    ({ activeKeyId, keys }) => keys.some(({ id }) => id === activeKeyId),
    {
      message: "must name a listed key",
      path: ["activeKeyId"],
    },
  );

const botSchema = z.strictObject({
  modelId: gatewayModelId.default(DEFAULT_MODEL_ID),
  fastModelId: gatewayModelId.default(DEFAULT_FAST_MODEL_ID),
  guardianModelId: gatewayModelId.default(DEFAULT_GUARDIAN_MODEL_ID),
  webSearchModelId: gatewayModelId.default(DEFAULT_WEB_SEARCH_MODEL_ID),
  refusalFallbackModelId: gatewayModelId.optional(),
  // Null turns vision off. Unset uses the default model.
  visionModelId: gatewayModelId.nullable().default(DEFAULT_VISION_MODEL_ID),
  decisionModelId: nonEmptyString.default(DEFAULT_DECISION_MODEL_ID),
  embeddingModelId: nonEmptyString.default(DEFAULT_EMBEDDING_MODEL_ID),
  rerankingModelId: nonEmptyString.default(DEFAULT_RERANKING_MODEL_ID),
  imageGenerationModelId: nonEmptyString.default(
    DEFAULT_IMAGE_GENERATION_MODEL_ID,
  ),
  transcriptionModelId: nonEmptyString.default(DEFAULT_TRANSCRIPTION_MODEL_ID),
  userName: z.string().trim().min(1).default("junior"),
  contextWindowTokens: positiveInt.default(DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS),
  reasoningLevel: z.enum(TURN_REASONING_LEVELS).default("high"),
  loadingMessages: z
    .array(z.string())
    .default(() => [...DEFAULT_ASSISTANT_LOADING_MESSAGES]),
  maxAgentDepth: z.number().int().nonnegative().default(1),
  maxSlicesPerTurn: positiveInt.default(MAX_SLICES_PER_TURN),
  maxToolCallsPerTurn: positiveInt.default(MAX_TOOL_CALLS_PER_TURN),
  maxTurnCostUsd: positiveInt.default(MAX_TURN_COST_USD),
  maxConsecutiveAutomatedTurns: positiveInt.default(
    MAX_CONSECUTIVE_AUTOMATED_TURNS,
  ),
  maxEventAutomationRuns: positiveInt.default(MAX_EVENT_AUTOMATION_RUNS),
  eventAutomationRunWindowMs: positiveInt.default(
    EVENT_AUTOMATION_RUN_WINDOW_MS,
  ),
  // Clamped to the function duration in `derive`.
  turnTimeoutMs: z.number().int().optional(),
});

const configObjectSchema = z.strictObject({
  /** Object storage for attachments and public artifacts. */
  attachmentStorage: attachmentStorageSchema.default({
    provider: "vercel-blob",
  }),
  bot: botSchema.prefault({}),
  queue: z
    .strictObject({
      /** Vercel Queues API base URL, for a local queue server. */
      apiUrl: z
        .string()
        .refine(isHttpUrl, "must be an http or https URL")
        .optional(),
    })
    .prefault({}),
  functionMaxDurationSeconds: z
    .number()
    .default(DEFAULT_FUNCTION_MAX_DURATION_SECONDS),
  /** Kill switch for prompt cache warming. Defaults to true. */
  cacheWarmingEnabled: z.boolean().default(true),
  /**
   * Kill switch for compaction on idle: a warmup of a prefix at or above the
   * background compaction mark swaps in a ready background summary instead.
   * Defaults to true. It runs only while cache warming is on.
   */
  idleCompactionEnabled: z.boolean().default(true),
  conversationWorkEnabled: z.boolean().default(true),
  /**
   * Keys for secrets at rest, as plain data. `createEncryptionKeyring` builds
   * the keyring. Startup fails when they are missing or invalid.
   */
  encryption: encryptionSchema,
  // No prefault: the database URL has no default.
  sql: z.strictObject({
    databaseUrl: z.string().trim().min(1),
    driver: z.enum(["neon", "postgres"]).optional(),
    statementTimeoutMs: z
      .union([positiveInt, z.literal(false)])
      .default(DEFAULT_SQL_STATEMENT_TIMEOUT_MS),
  }),
  slack: z
    .strictObject({
      botToken: z.string().optional(),
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      completedReactionEmoji: z
        .string()
        .default(DEFAULT_COMPLETED_REACTION_EMOJI),
      processingReactionEmoji: z
        .string()
        .default(DEFAULT_PROCESSING_REACTION_EMOJI),
      signingSecret: z.string().optional(),
    })
    .prefault({}),
  sandbox: z
    .strictObject({
      /** Sandbox provider for this deployment. `docker` is for local development. */
      provider: z.enum(["vercel", "docker"]).default("vercel"),
    })
    .prefault({}),
  state: z
    .strictObject({
      adapter: z.enum(["memory", "redis"]).default("redis"),
      keyPrefix: z.string().optional(),
      redisUrl: z.string().optional(),
    })
    .prefault({}),
});

const configSchema = configObjectSchema.transform(derive);

// A local database URL uses node-postgres. Any other URL uses Neon.
function defaultSqlDriver(databaseUrl: string): "neon" | "postgres" {
  try {
    const { hostname } = new URL(databaseUrl);
    return hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
      ? "postgres"
      : "neon";
  } catch {
    return "neon";
  }
}

function derive(config: z.output<typeof configObjectSchema>) {
  const { bot, functionMaxDurationSeconds, sql } = config;
  return {
    ...config,
    bot: {
      ...bot,
      turnTimeoutMs: Math.max(
        MIN_AGENT_TURN_TIMEOUT_MS,
        Math.min(
          bot.turnTimeoutMs ?? DEFAULT_AGENT_TURN_TIMEOUT_MS,
          resolveMaxTurnTimeoutMs(functionMaxDurationSeconds),
        ),
      ),
      visionModelId: bot.visionModelId ?? undefined,
    },
    conversationWorkSoftYieldAfterMs: resolveConversationWorkSoftYieldAfterMs(
      functionMaxDurationSeconds,
    ),
    sql: {
      ...sql,
      driver: sql.driver ?? defaultSqlDriver(sql.databaseUrl),
    },
  };
}

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Fully resolved Junior config. */
export type JuniorConfig = z.output<typeof configSchema>;
/** Config values a host passes in code. Unset values come from env, then defaults. */
export type ConfigInput = DeepPartial<z.input<typeof configSchema>>;
/** Object storage for attachments and public artifacts. */
export type AttachmentStorageConfig = JuniorConfig["attachmentStorage"];
/** Settings for an S3-compatible object store. */
export type S3StorageConfig = Extract<
  AttachmentStorageConfig,
  { provider: "s3" }
>["s3"];
/** Encryption keys as plain data. */
export type EncryptionConfig = JuniorConfig["encryption"];

/** Env var that sets each config field, for error messages. */
const ENV_NAMES: Record<string, string> = {
  "bot.modelId": "AI_MODEL",
  "bot.fastModelId": "AI_FAST_MODEL",
  "bot.guardianModelId": "AI_GUARDIAN_MODEL",
  "bot.webSearchModelId": "AI_WEB_SEARCH_MODEL",
  "bot.refusalFallbackModelId": "AI_REFUSAL_FALLBACK_MODEL",
  "bot.visionModelId": "AI_VISION_MODEL",
  "bot.decisionModelId": "AI_DECISION_MODEL",
  "bot.embeddingModelId": "AI_EMBEDDING_MODEL",
  "bot.rerankingModelId": "AI_RERANKING_MODEL",
  "bot.imageGenerationModelId": "AI_IMAGE_MODEL",
  "bot.transcriptionModelId": "AI_TRANSCRIPTION_MODEL",
  "bot.userName": "JUNIOR_BOT_NAME",
  "bot.contextWindowTokens": "AI_MODEL_CONTEXT_WINDOW_TOKENS",
  "bot.reasoningLevel": "AI_REASONING_LEVEL",
  "bot.loadingMessages": "JUNIOR_LOADING_MESSAGES",
  "bot.turnTimeoutMs": "AGENT_TURN_TIMEOUT_MS",
  attachmentStorage: "JUNIOR_ATTACHMENT_STORAGE_PROVIDER",
  "attachmentStorage.s3.accessKeyId": "JUNIOR_S3_ACCESS_KEY_ID",
  "attachmentStorage.s3.bucket": "JUNIOR_S3_BUCKET",
  "attachmentStorage.s3.endpoint": "JUNIOR_S3_ENDPOINT",
  "attachmentStorage.s3.region": "JUNIOR_S3_REGION",
  "attachmentStorage.s3.secretAccessKey": "JUNIOR_S3_SECRET_ACCESS_KEY",
  "queue.apiUrl": "JUNIOR_QUEUE_API_URL",
  cacheWarmingEnabled: "JUNIOR_CACHE_WARMING_ENABLED",
  idleCompactionEnabled: "JUNIOR_IDLE_COMPACTION_ENABLED",
  conversationWorkEnabled: "JUNIOR_CONVERSATION_WORK_ENABLED",
  encryption: "JUNIOR_ENCRYPTION_KEYS",
  "encryption.activeKeyId": "JUNIOR_ENCRYPTION_KEY_ID",
  "sql.databaseUrl": "DATABASE_URL",
  "sql.driver": "JUNIOR_DATABASE_DRIVER",
  "sql.statementTimeoutMs": "JUNIOR_SQL_STATEMENT_TIMEOUT_MS",
  "slack.botToken": "SLACK_BOT_TOKEN",
  "slack.clientId": "SLACK_CLIENT_ID",
  "slack.clientSecret": "SLACK_CLIENT_SECRET",
  "slack.signingSecret": "SLACK_SIGNING_SECRET",
  "sandbox.provider": "JUNIOR_SANDBOX_PROVIDER",
  "state.adapter": "JUNIOR_STATE_ADAPTER",
  "state.keyPrefix": "JUNIOR_STATE_KEY_PREFIX",
  "state.redisUrl": "REDIS_URL",
};

type Env = Record<string, string | undefined>;

function parseLoadingMessages(rawValue: string | undefined) {
  const trimmed = rawValue?.trim();
  if (!trimmed) {
    return undefined;
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

// Operational kill switches default to on. Only "false" turns them off.
function parseKillSwitch(name: string, rawValue: string | undefined): boolean {
  const value = toOptionalTrimmed(rawValue)?.toLowerCase();
  if (value === undefined || value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function parseSqlDriver(rawValue: string | undefined) {
  const value = toOptionalTrimmed(rawValue);
  if (value === undefined || value === "neon" || value === "postgres") {
    return value;
  }
  throw new Error("JUNIOR_DATABASE_DRIVER must be postgres or neon");
}

function parseSqlStatementTimeoutMs(
  rawValue: string | undefined,
): number | false | undefined {
  const trimmed = toOptionalTrimmed(rawValue);
  if (trimmed === undefined) {
    return undefined;
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== trimmed) {
    throw new Error(
      "JUNIOR_SQL_STATEMENT_TIMEOUT_MS must be a non-negative integer",
    );
  }
  return value === 0 ? false : value;
}

function parseTurnTimeoutMs(rawValue: string | undefined): number | undefined {
  const value = Number.parseInt(rawValue ?? "", 10);
  return Number.isNaN(value) ? undefined : value;
}

// Set but empty turns vision off, so it maps to null, not to unset.
function parseVisionModelId(rawValue: string | undefined) {
  if (rawValue === undefined) {
    return undefined;
  }
  return toOptionalTrimmed(rawValue) ?? null;
}

function readS3Setting(env: Env, name: string): string {
  const value = toOptionalTrimmed(env[name]);
  if (value === undefined) {
    throw new Error(
      `${name} is required when JUNIOR_ATTACHMENT_STORAGE_PROVIDER is s3`,
    );
  }
  return value;
}

function readAttachmentStorage(env: Env): ConfigInput["attachmentStorage"] {
  const provider = toOptionalTrimmed(env["JUNIOR_ATTACHMENT_STORAGE_PROVIDER"]);
  switch (provider) {
    case undefined:
      return undefined;
    case "vercel-blob":
    case "memory":
      return { provider };
    case "s3":
      return {
        provider,
        s3: {
          accessKeyId: readS3Setting(env, "JUNIOR_S3_ACCESS_KEY_ID"),
          bucket: readS3Setting(env, "JUNIOR_S3_BUCKET"),
          endpoint: readS3Setting(env, "JUNIOR_S3_ENDPOINT"),
          region: toOptionalTrimmed(env["JUNIOR_S3_REGION"]),
          secretAccessKey: readS3Setting(env, "JUNIOR_S3_SECRET_ACCESS_KEY"),
        },
      };
    default:
      throw new Error(
        "JUNIOR_ATTACHMENT_STORAGE_PROVIDER must be vercel-blob, s3, or memory",
      );
  }
}

function parseQueueApiUrl(rawValue: string | undefined): string | undefined {
  const value = toOptionalTrimmed(rawValue);
  if (value === undefined || isHttpUrl(value)) {
    return value;
  }
  throw new Error("JUNIOR_QUEUE_API_URL must be an http or https URL");
}

function parseEncryptionKey(entry: string, index: number) {
  const separator = entry.indexOf(":");
  const id = entry.slice(0, separator).trim();
  const key = entry.slice(separator + 1).trim();
  // Errors name the entry, never the key material.
  if (separator < 0 || !ENCRYPTION_KEY_ID_PATTERN.test(id)) {
    throw new Error(
      `JUNIOR_ENCRYPTION_KEYS entry ${index + 1} must be <id>:<key> with an id of letters, digits, ".", "_", or "-"`,
    );
  }
  if (!isEncryptionKeyMaterial(key)) {
    throw new Error(
      `JUNIOR_ENCRYPTION_KEYS key "${id}" must be ${ENCRYPTION_KEY_BYTES} bytes in base64`,
    );
  }
  return { id, key };
}

/**
 * `JUNIOR_ENCRYPTION_KEYS` lists `<id>:<key>` entries, comma-separated.
 * `JUNIOR_ENCRYPTION_KEY_ID` names the key for new values; it is optional
 * when there is one key. All listed keys decrypt.
 */
function readEncryption(env: Env): ConfigInput["encryption"] {
  const entries = (env["JUNIOR_ENCRYPTION_KEYS"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  // No default key, not even for local development: each deployment must
  // generate its own. The schema reports the missing keys.
  if (entries.length === 0) {
    return undefined;
  }
  const keys = entries.map(parseEncryptionKey);
  if (new Set(keys.map(({ id }) => id)).size !== keys.length) {
    throw new Error("JUNIOR_ENCRYPTION_KEYS must not repeat a key id");
  }
  const activeKeyId =
    env["JUNIOR_ENCRYPTION_KEY_ID"]?.trim() ||
    (keys.length === 1 ? keys[0]?.id : undefined);
  if (!activeKeyId) {
    throw new Error(
      "JUNIOR_ENCRYPTION_KEY_ID is required when JUNIOR_ENCRYPTION_KEYS has more than one key",
    );
  }
  if (!keys.some(({ id }) => id === activeKeyId)) {
    throw new Error(
      `JUNIOR_ENCRYPTION_KEY_ID "${activeKeyId}" is not in JUNIOR_ENCRYPTION_KEYS`,
    );
  }
  return { activeKeyId, keys };
}

// Maps env vars onto config fields and parses their strings. Errors name the
// env var.
function readEnv(env: Env): ConfigInput {
  const reasoningLevel = toOptionalTrimmed(env["AI_REASONING_LEVEL"]);
  return {
    attachmentStorage: readAttachmentStorage(env),
    bot: {
      modelId: toOptionalTrimmed(env["AI_MODEL"]),
      // An empty AI_FAST_MODEL does not fall back to AI_MODEL.
      fastModelId: toOptionalTrimmed(env["AI_FAST_MODEL"] ?? env["AI_MODEL"]),
      guardianModelId: toOptionalTrimmed(env["AI_GUARDIAN_MODEL"]),
      webSearchModelId: toOptionalTrimmed(env["AI_WEB_SEARCH_MODEL"]),
      refusalFallbackModelId: toOptionalTrimmed(
        env["AI_REFUSAL_FALLBACK_MODEL"],
      ),
      visionModelId: parseVisionModelId(env["AI_VISION_MODEL"]),
      decisionModelId: toOptionalTrimmed(env["AI_DECISION_MODEL"]),
      embeddingModelId: toOptionalTrimmed(env["AI_EMBEDDING_MODEL"]),
      rerankingModelId: toOptionalTrimmed(env["AI_RERANKING_MODEL"]),
      imageGenerationModelId: toOptionalTrimmed(env["AI_IMAGE_MODEL"]),
      transcriptionModelId: toOptionalTrimmed(env["AI_TRANSCRIPTION_MODEL"]),
      userName: toOptionalTrimmed(env["JUNIOR_BOT_NAME"]),
      contextWindowTokens: parseOptionalPositiveInteger(
        "AI_MODEL_CONTEXT_WINDOW_TOKENS",
        env["AI_MODEL_CONTEXT_WINDOW_TOKENS"],
      ),
      reasoningLevel:
        reasoningLevel === undefined
          ? undefined
          : parseTurnReasoningLevel(reasoningLevel),
      loadingMessages: parseLoadingMessages(env["JUNIOR_LOADING_MESSAGES"]),
      turnTimeoutMs: parseTurnTimeoutMs(env["AGENT_TURN_TIMEOUT_MS"]),
    },
    queue: { apiUrl: parseQueueApiUrl(env["JUNIOR_QUEUE_API_URL"]) },
    cacheWarmingEnabled: parseKillSwitch(
      "JUNIOR_CACHE_WARMING_ENABLED",
      env["JUNIOR_CACHE_WARMING_ENABLED"],
    ),
    idleCompactionEnabled: parseKillSwitch(
      "JUNIOR_IDLE_COMPACTION_ENABLED",
      env["JUNIOR_IDLE_COMPACTION_ENABLED"],
    ),
    conversationWorkEnabled: parseKillSwitch(
      "JUNIOR_CONVERSATION_WORK_ENABLED",
      env["JUNIOR_CONVERSATION_WORK_ENABLED"],
    ),
    encryption: readEncryption(env),
    sql: {
      databaseUrl: toOptionalTrimmed(env["DATABASE_URL"]),
      driver: parseSqlDriver(env["JUNIOR_DATABASE_DRIVER"]),
      statementTimeoutMs: parseSqlStatementTimeoutMs(
        env["JUNIOR_SQL_STATEMENT_TIMEOUT_MS"],
      ),
    },
    slack: {
      botToken:
        toOptionalTrimmed(env["SLACK_BOT_TOKEN"]) ??
        toOptionalTrimmed(env["SLACK_BOT_USER_TOKEN"]),
      clientId: toOptionalTrimmed(env["SLACK_CLIENT_ID"]),
      clientSecret: toOptionalTrimmed(env["SLACK_CLIENT_SECRET"]),
      signingSecret: toOptionalTrimmed(env["SLACK_SIGNING_SECRET"]),
    },
    sandbox: {
      provider:
        env["JUNIOR_SANDBOX_PROVIDER"]?.trim().toLowerCase() === "docker"
          ? "docker"
          : undefined,
    },
    state: {
      adapter:
        env["JUNIOR_STATE_ADAPTER"]?.trim().toLowerCase() === "memory"
          ? "memory"
          : undefined,
      keyPrefix: toOptionalTrimmed(env["JUNIOR_STATE_KEY_PREFIX"]),
      redisUrl: toOptionalTrimmed(env["REDIS_URL"]),
    },
  };
}

// Plain objects only: arrays, Buffers, and class instances are values.
const plainObjectSchema = z.record(z.string(), z.unknown());

// `b` wins. Plain objects merge per key, arrays and scalars replace, and
// undefined values are skipped.
function mergeConfig(a: unknown, b: unknown): unknown {
  if (b === undefined) {
    return a;
  }
  const left = plainObjectSchema.safeParse(a);
  const right = plainObjectSchema.safeParse(b);
  if (!left.success || !right.success) {
    return b;
  }
  const merged: Record<string, unknown> = {};
  for (const key of new Set([
    ...Object.keys(left.data),
    ...Object.keys(right.data),
  ])) {
    const value = mergeConfig(left.data[key], right.data[key]);
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let value = input;
  for (const key of path) {
    const object = plainObjectSchema.safeParse(value);
    if (!object.success || typeof key === "symbol") {
      return undefined;
    }
    value = object.data[String(key)];
  }
  return value;
}

// The env var of the field, or of its nearest group that has one.
function envNameFor(path: readonly PropertyKey[]): string | undefined {
  const keys = path.filter((key) => typeof key === "string");
  for (let length = keys.length; length > 0; length--) {
    const envName = ENV_NAMES[keys.slice(0, length).join(".")];
    if (envName) {
      return envName;
    }
  }
  return undefined;
}

function formatIssue(input: unknown, issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join(".");
  const envName = envNameFor(issue.path);
  if (
    issue.code === "invalid_type" &&
    valueAt(input, issue.path) === undefined
  ) {
    const required = `${envName ?? path} is required`;
    return path === "encryption"
      ? `${required}. ${ENCRYPTION_KEYS_HINT}`
      : required;
  }
  return `${envName ? `${path} (${envName})` : path}: ${issue.message}`;
}

/** Resolve config: host options win over env, and the schema fills defaults. */
export function loadConfig({
  env = {},
  options = {},
}: { env?: Env; options?: ConfigInput } = {}): JuniorConfig {
  const input = mergeConfig(readEnv(env), options);
  const result = configSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      result.error.issues.map((issue) => formatIssue(input, issue)).join("; "),
    );
  }
  return result.data;
}
