// The bot group: models, the bot name, and per-turn limits. `deriveBot`
// applies `createApp({ limits })` over them.
import * as z from "zod";
import { toOptionalTrimmed } from "@/chat/optional-string";
import { resolveGatewayModel } from "@/chat/pi/gateway-models";
import {
  parseTurnReasoningLevel,
  TURN_REASONING_LEVELS,
} from "@/chat/reasoning-level";
import { optionCheck, positiveInt, type Env } from "@/config/fields";
import {
  MIN_AGENT_TURN_TIMEOUT_MS,
  resolveMaxTurnTimeoutMs,
} from "@/config/function-duration";

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
const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 400_000;
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

// Env values are never empty, so only an option reaches the empty check.
function modelId(option: string) {
  return z
    .string()
    .trim()
    .refine((id) => id.length > 0, {
      ...optionCheck(`${option} must not be empty`),
      // An empty id skips the gateway check.
      abort: true,
    });
}
// `resolveGatewayModel` throws its own error for an unknown id, and that error
// leaves `safeParse` unchanged.
function gatewayModelId(option: string) {
  return modelId(option).refine((id) => Boolean(resolveGatewayModel(id)));
}

function positiveLimit(name: string) {
  return z
    .number()
    .refine(
      (value) => Number.isSafeInteger(value) && value > 0,
      optionCheck(`limits.${name} must be a positive integer`),
    );
}

/**
 * Limits from `createApp({ limits })`. `derive` applies them over the bot
 * settings, so they win over env, and the turn timeout is only capped by the
 * function duration.
 */
export const limitsSchema = z.strictObject({
  contextWindowTokens: positiveLimit("contextWindowTokens").optional(),
  maxAgentDepth: z
    .number()
    .refine(
      (value) => Number.isSafeInteger(value) && value >= 0,
      optionCheck("limits.maxAgentDepth must be a non-negative integer"),
    )
    .optional(),
  maxConsecutiveAutomatedTurns: positiveLimit(
    "maxConsecutiveAutomatedTurns",
  ).optional(),
  eventAutomationRunLimit: z
    .strictObject({
      maxRuns: positiveLimit("eventAutomationRunLimit.maxRuns").optional(),
      windowMs: positiveLimit("eventAutomationRunLimit.windowMs").optional(),
    })
    .optional(),
  maxSlicesPerTurn: positiveLimit("maxSlicesPerTurn").optional(),
  maxToolCallsPerTurn: positiveLimit("maxToolCallsPerTurn").optional(),
  maxTurnCostUsd: positiveLimit("maxTurnCostUsd").optional(),
  turnTimeoutMs: positiveLimit("turnTimeoutMs").optional(),
});

/** Models, the bot name, and per-turn limits. */
export const botSchema = z.strictObject({
  modelId: gatewayModelId("modelId").default(DEFAULT_MODEL_ID),
  fastModelId: gatewayModelId("fastModelId").default(DEFAULT_FAST_MODEL_ID),
  guardianModelId: gatewayModelId("guardianModelId").default(
    DEFAULT_GUARDIAN_MODEL_ID,
  ),
  webSearchModelId: gatewayModelId("webSearchModelId").default(
    DEFAULT_WEB_SEARCH_MODEL_ID,
  ),
  refusalFallbackModelId: gatewayModelId("refusalFallbackModelId").optional(),
  // Null turns vision off. Unset uses the default model.
  visionModelId: gatewayModelId("visionModelId")
    .nullable()
    .default(DEFAULT_VISION_MODEL_ID),
  decisionModelId: modelId("decisionModelId").default(
    DEFAULT_DECISION_MODEL_ID,
  ),
  embeddingModelId: modelId("embeddingModelId").default(
    DEFAULT_EMBEDDING_MODEL_ID,
  ),
  rerankingModelId: modelId("rerankingModelId").default(
    DEFAULT_RERANKING_MODEL_ID,
  ),
  imageGenerationModelId: modelId("imageGenerationModelId").default(
    DEFAULT_IMAGE_GENERATION_MODEL_ID,
  ),
  transcriptionModelId: modelId("transcriptionModelId").default(
    DEFAULT_TRANSCRIPTION_MODEL_ID,
  ),
  // The build's `juniorNitro({ botName })` is the option.
  userName: z
    .string()
    .trim()
    .refine((name) => name.length > 0, optionCheck("botName must not be empty"))
    .default("junior"),
  contextWindowTokens: positiveInt.default(DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS),
  reasoningLevel: z.enum(TURN_REASONING_LEVELS).default("high"),
  loadingMessages: z
    .array(z.string())
    .default(() => [...DEFAULT_ASSISTANT_LOADING_MESSAGES]),
  maxAgentDepth: z.number().int().nonnegative().default(2),
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

/** Env var that sets each bot field, for error messages. */
export const botEnvNames: Record<string, string> = {
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
};

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

/** Read the bot group from env. */
export function readBotEnv(env: Env) {
  const reasoningLevel = toOptionalTrimmed(env["AI_REASONING_LEVEL"]);
  return {
    modelId: toOptionalTrimmed(env["AI_MODEL"]),
    // An empty AI_FAST_MODEL does not fall back to AI_MODEL.
    fastModelId: toOptionalTrimmed(env["AI_FAST_MODEL"] ?? env["AI_MODEL"]),
    guardianModelId: toOptionalTrimmed(env["AI_GUARDIAN_MODEL"]),
    webSearchModelId: toOptionalTrimmed(env["AI_WEB_SEARCH_MODEL"]),
    refusalFallbackModelId: toOptionalTrimmed(env["AI_REFUSAL_FALLBACK_MODEL"]),
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
  };
}

/**
 * Apply the createApp limits over the bot settings, and cap the turn timeout
 * at the function duration.
 */
export function deriveBot(
  bot: z.output<typeof botSchema>,
  limits: z.output<typeof limitsSchema>,
  functionMaxDurationSeconds: number,
) {
  const maxTurnTimeoutMs = resolveMaxTurnTimeoutMs(functionMaxDurationSeconds);
  return {
    ...bot,
    contextWindowTokens: limits.contextWindowTokens ?? bot.contextWindowTokens,
    maxAgentDepth: limits.maxAgentDepth ?? bot.maxAgentDepth,
    maxConsecutiveAutomatedTurns:
      limits.maxConsecutiveAutomatedTurns ?? bot.maxConsecutiveAutomatedTurns,
    maxEventAutomationRuns:
      limits.eventAutomationRunLimit?.maxRuns ?? bot.maxEventAutomationRuns,
    eventAutomationRunWindowMs:
      limits.eventAutomationRunLimit?.windowMs ??
      bot.eventAutomationRunWindowMs,
    maxSlicesPerTurn: limits.maxSlicesPerTurn ?? bot.maxSlicesPerTurn,
    maxToolCallsPerTurn: limits.maxToolCallsPerTurn ?? bot.maxToolCallsPerTurn,
    maxTurnCostUsd: limits.maxTurnCostUsd ?? bot.maxTurnCostUsd,
    // A turn timeout limit is not raised to the minimum, only capped.
    turnTimeoutMs:
      limits.turnTimeoutMs === undefined
        ? Math.max(
            MIN_AGENT_TURN_TIMEOUT_MS,
            Math.min(
              bot.turnTimeoutMs ?? DEFAULT_AGENT_TURN_TIMEOUT_MS,
              maxTurnTimeoutMs,
            ),
          )
        : Math.min(limits.turnTimeoutMs, maxTurnTimeoutMs),
    visionModelId: bot.visionModelId ?? undefined,
  };
}
