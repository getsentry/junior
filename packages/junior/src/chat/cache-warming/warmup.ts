/**
 * Prompt cache warming for idle Conversations.
 *
 * After a turn ends, the next human message often arrives after the short
 * prompt cache TTL. Then the full history is written to the cache again. A
 * warmup sends the same request again with a one-token output limit before
 * the cache expires. The provider reads the cached prefix and refreshes its
 * TTL. `model.ts` owns the cost model.
 *
 * Each idle period gets one recorded reply gap, so the model also sees the
 * people who do not reply. A reply records its gap. A delayed `horizon`
 * message records `NO_REPLY_GAP_MS` when no reply came in the idle horizon.
 *
 * Only a Turn writes the Conversation state. Warmups and the horizon run
 * while the next Turn can start, so they write only keys of their own idle
 * period (`generation`): the snapshot, the warmup count, and the gap claim.
 * Work for an old idle period then cannot change a newer one.
 */
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gunzip as gunzipCallback, gzip as gzipCallback } from "node:zlib";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  streamSimple,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai/compat";
import { getChatConfig } from "@/chat/config";
import { runWithLogContext } from "@/chat/log-context";
import { logInfo, logWarn } from "@/chat/logging";
import { completeText } from "@/chat/core-model";
import { resolveGatewayModel } from "@/chat/pi/client";
import type { CacheRetention, ThinkingLevel } from "@/chat/pi/sdk";
import { captureMessage } from "@/chat/sentry";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  decideWarmup,
  gapSegment,
  IDLE_HORIZON_MS,
  MINUTE_MS,
  MIN_WARMUP_PREFIX_TOKENS,
  NO_REPLY_GAP_MS,
  warmupMarginMs,
} from "./model";
import { sendCacheWarmup, type CacheWarmupMessage } from "./queue";

// Compress off the event loop, so a large snapshot does not delay other work.
const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

const KEY_PREFIX = "junior:cache_warming";
const GLOBAL_GAPS_MAX = 2_000;
const GLOBAL_GAPS_TTL_MS = 30 * 24 * 60 * MINUTE_MS;
const CONVERSATION_GAPS_MAX = 50;
const CONVERSATION_STATE_TTL_MS = 7 * 24 * 60 * MINUTE_MS;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
// A refreshed prefix reads almost all of the stored prefix from the cache.
const REFRESHED_READ_FRACTION = 0.9;
// A miss ends only its own idle period. When many recent warmups of one
// provider miss, its warmup request or cache is likely broken, so warming of
// that provider stops for every Conversation for a day.
const BREAKER_OUTCOMES_MAX = 20;
const BREAKER_MAX_MISSES = 10;
const BREAKER_OUTCOMES_TTL_MS = 6 * 60 * MINUTE_MS;
const BREAKER_OPEN_TTL_MS = 24 * 60 * MINUTE_MS;
// While warming is on, the recorder sets this retention on agent requests, so
// Pi's PI_CACHE_RETENTION does not change them. The cost model and the warmup
// timing use the TTL of this retention (`CACHE_TTL_MS`).
const CACHE_RETENTION: CacheRetention = "short";

/** Warming stops when the snapshot of the idle period is deleted. */
interface WarmState {
  modelId: string;
  prefixTokens: number;
  cacheTtlMs: number;
  reasoning?: ThinkingLevel;
}

interface IdlePeriod {
  generation: string;
  /** The `gapSegment` that this period records its gap in. */
  segment: string;
  /** Start of the request that ended the turn. */
  sinceMs: number;
  /** Only periods that could be warmed record gaps. */
  warm?: WarmState;
}

interface ConversationCacheState {
  /** Turns of this Conversation that ended. */
  endedTurns?: number;
  idle?: IdlePeriod;
}

interface ModelRequest {
  model: Model<Api>;
  context: Context;
  reasoning?: ThinkingLevel;
  cacheRetention?: CacheRetention;
  startedAtMs: number;
}

const segmentGapsKey = (segment: string) => `${KEY_PREFIX}:gaps:${segment}`;
const conversationKey = (conversationId: string) =>
  `${KEY_PREFIX}:conversation:${conversationId}`;
/** Recent reply gaps (ms) of the idle periods of this Conversation. */
const conversationGapsKey = (conversationId: string) =>
  `${KEY_PREFIX}:gaps:conversation:${conversationId}`;
const snapshotKey = (conversationId: string, generation: string) =>
  `${KEY_PREFIX}:snapshot:${conversationId}:${generation}`;
/** Warmups that completed in the idle period. */
const warmupsKey = (conversationId: string, generation: string) =>
  `${KEY_PREFIX}:warmups:${conversationId}:${generation}`;
/** Set by the first of the reply and the horizon to record the gap. */
const gapClaimKey = (conversationId: string, generation: string) =>
  `${KEY_PREFIX}:gap_claim:${conversationId}:${generation}`;
// The breaker is per provider, so a provider whose cache behaves differently
// than its TTL says cannot stop warming for the others.
const breakerOutcomesKey = (provider: string) =>
  `${KEY_PREFIX}:breaker:${provider}:outcomes`;
const breakerOpenKey = (provider: string) =>
  `${KEY_PREFIX}:breaker:${provider}:open`;
const providerOf = (modelId: string) => modelId.split("/")[0] ?? "";

async function connectedState() {
  const state = getStateAdapter();
  await state.connect();
  return state;
}

type ConnectedState = Awaited<ReturnType<typeof connectedState>>;

// How long the cache of each provider lives after a write or a read. The
// warmup timing and the reply chance use it. Warming needs a fixed TTL that a
// read refreshes. Providers without one are not listed and are not warmed.
//
// The TTLs come from models.dev (`cache.explicit.ttl` in
// providers/<provider>/models/*.toml; its api.json does not publish them).
// Check them again when a provider or model family is added:
// - https://github.com/anomalyco/models.dev/tree/dev/providers/anthropic/models
//   Every model lists ["5m", "1h"]. Junior uses the short retention.
// - https://github.com/anomalyco/models.dev/tree/dev/providers/alibaba/models
//   Every Qwen model with an explicit cache lists ["5m"].
// - https://github.com/anomalyco/models.dev/tree/dev/providers/openai/models
//   GPT-5.6 and later list ["30m"]. Earlier models list ["24h"] or nothing,
//   and Pi gives them no cache write price, so the price check skips them.
// The provider docs say that a cache hit resets the TTL:
// - https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
// - https://www.alibabacloud.com/help/en/model-studio/context-cache
// - https://platform.openai.com/docs/guides/prompt-caching ("A 30-minute
//   read refreshes coverage to at least 30 minutes after that read.")
// Not listed: MiniMax (no TTL on models.dev).
const CACHE_TTL_MS: Record<string, number> = {
  anthropic: 5 * MINUTE_MS,
  alibaba: 5 * MINUTE_MS,
  openai: 30 * MINUTE_MS,
};

// Return the cache TTL of a model that Junior can warm.
function cacheTtlMs(request: ModelRequest): number | undefined {
  return supportsWarming(request)
    ? CACHE_TTL_MS[providerOf(request.model.id)]
    : undefined;
}

// Warming pays only when a cache write costs more than a read. Pi adds a
// thinking budget to the one-token output limit on the Anthropic Messages API
// for models without adaptive thinking. Then a warmup could cost as much as a
// short answer, and a smaller budget would miss the cached messages.
function supportsWarming(request: ModelRequest): boolean {
  const { model, reasoning } = request;
  const budgetThinking =
    reasoning !== undefined &&
    model.api === "anthropic-messages" &&
    (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking !==
      true;
  return (
    CACHE_TTL_MS[providerOf(model.id)] !== undefined &&
    model.cost.cacheRead > 0 &&
    model.cost.cacheWrite > model.cost.cacheRead &&
    !budgetThinking &&
    request.cacheRetention === CACHE_RETENTION
  );
}

// A warmup this close to the cache expiry may reach the provider after it.
const LATE_WARMUP_MS = 10_000;

// Send the warmup that refreshes the cache that a request at
// `requestStartedAtMs` read or wrote.
async function scheduleWarmup(
  message: Omit<
    Extract<CacheWarmupMessage, { kind: "warmup" }>,
    "cacheExpiresAtMs"
  >,
  requestStartedAtMs: number,
  warm: WarmState,
): Promise<void> {
  const cacheExpiresAtMs = requestStartedAtMs + warm.cacheTtlMs;
  await sendCacheWarmup(
    { ...message, cacheExpiresAtMs },
    cacheExpiresAtMs - warmupMarginMs(warm.prefixTokens) - Date.now(),
  );
}

// Keep only the tool fields that Pi sends to the provider.
function snapshotContext(context: Context): Context {
  return {
    ...(context.systemPrompt !== undefined
      ? { systemPrompt: context.systemPrompt }
      : undefined),
    messages: context.messages,
    ...(context.tools
      ? {
          tools: context.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            ...(tool.constrainedSampling !== undefined
              ? { constrainedSampling: tool.constrainedSampling }
              : undefined),
          })),
        }
      : undefined),
  };
}

// The reply and the horizon can run at the same time. Only the first one to
// claim the idle period records its gap.
async function recordGap(
  state: ConnectedState,
  conversationId: string,
  idle: IdlePeriod,
  gapMs: number,
): Promise<void> {
  const claimed = await state.setIfNotExists(
    gapClaimKey(conversationId, idle.generation),
    true,
    CONVERSATION_STATE_TTL_MS,
  );
  if (!claimed) {
    return;
  }
  await state.appendToList(segmentGapsKey(idle.segment), gapMs, {
    maxLength: GLOBAL_GAPS_MAX,
    ttlMs: GLOBAL_GAPS_TTL_MS,
  });
  await state.appendToList(conversationGapsKey(conversationId), gapMs, {
    maxLength: CONVERSATION_GAPS_MAX,
    ttlMs: CONVERSATION_STATE_TTL_MS,
  });
}

async function startIdlePeriod(
  state: ConnectedState,
  conversationId: string,
  request: ModelRequest,
  message: AssistantMessage,
  segment: string,
): Promise<IdlePeriod> {
  const idle: IdlePeriod = {
    generation: randomUUID(),
    segment,
    sinceMs: request.startedAtMs,
  };
  const prefixTokens = message.usage.cacheRead + message.usage.cacheWrite;
  const ttlMs = cacheTtlMs(request);
  if (ttlMs === undefined || prefixTokens < MIN_WARMUP_PREFIX_TOKENS) {
    return idle;
  }
  // State values are JSON, so the compressed bytes are stored as base64.
  const snapshot = (
    await gzip(JSON.stringify(snapshotContext(request.context)))
  ).toString("base64");
  if (snapshot.length > MAX_SNAPSHOT_BYTES) {
    logInfo("cache_warming.snapshot.skipped", {
      "app.cache_warming.prefix_tokens": prefixTokens,
      "app.cache_warming.snapshot_bytes": snapshot.length,
    });
    return idle;
  }
  await state.set(
    snapshotKey(conversationId, idle.generation),
    snapshot,
    IDLE_HORIZON_MS,
  );
  return {
    ...idle,
    warm: {
      modelId: request.model.id,
      prefixTokens,
      cacheTtlMs: ttlMs,
      ...(request.reasoning ? { reasoning: request.reasoning } : undefined),
    },
  };
}

async function recordModelCall(
  conversationId: string,
  userActor: boolean,
  request: ModelRequest,
  message: AssistantMessage,
): Promise<void> {
  const state = await connectedState();
  const previous = await state.get<ConversationCacheState>(
    conversationKey(conversationId),
  );
  const idle = previous?.idle;
  if (idle?.warm) {
    const gapMs = request.startedAtMs - idle.sinceMs;
    if (gapMs > 0) {
      await recordGap(state, conversationId, idle, gapMs);
    }
    await state.delete(snapshotKey(conversationId, idle.generation));
    const warmups =
      (await state.get<number>(warmupsKey(conversationId, idle.generation))) ??
      0;
    if (warmups > 0) {
      logInfo("cache_warming.conversation.returned", {
        "app.cache_warming.gap_ms": gapMs,
        "app.cache_warming.prefix_tokens": idle.warm.prefixTokens,
        "app.cache_warming.warmup_count": warmups,
        "gen_ai.usage.cache_read.input_tokens": message.usage.cacheRead,
        "gen_ai.usage.cache_creation.input_tokens": message.usage.cacheWrite,
      });
    }
  }

  // Mid-turn calls arrive seconds apart. Only the call that ends a turn
  // starts an idle period.
  const endedTurns = previous?.endedTurns ?? 0;
  const next: ConversationCacheState =
    message.stopReason === "stop"
      ? {
          endedTurns: endedTurns + 1,
          idle: await startIdlePeriod(
            state,
            conversationId,
            request,
            message,
            gapSegment(userActor, endedTurns),
          ),
        }
      : { endedTurns };
  if (!idle && !next.idle) {
    return;
  }
  await state.set(
    conversationKey(conversationId),
    next,
    CONVERSATION_STATE_TTL_MS,
  );
  if (next.idle?.warm) {
    const { generation } = next.idle;
    await scheduleWarmup(
      { kind: "warmup", conversationId, cycle: 1, generation },
      request.startedAtMs,
      next.idle.warm,
    );
    await sendCacheWarmup(
      { kind: "horizon", conversationId, generation },
      request.startedAtMs + IDLE_HORIZON_MS - Date.now(),
    );
  }
}

/** Records the model calls of one agent run and schedules cache warmups. */
export interface CacheWarmingRecorder {
  /**
   * Wrap the stream function so the recorder sees each model request. The
   * wrapper also sets the cache retention that warming assumes while warming
   * is on.
   */
  wrap(base?: StreamFn): StreamFn;
  /** Record the finished assistant message of the last model request. */
  record(message: AssistantMessage): Promise<void>;
}

/**
 * Create a recorder for one agent run. `userActor` is true when a person
 * started the Turn. A failure to record only loses cache warming, so it is
 * logged and does not stop the run.
 */
export function createCacheWarmingRecorder(
  conversationId: string,
  userActor: boolean,
): CacheWarmingRecorder {
  let lastRequest: ModelRequest | undefined;
  // After the first call of the run ends the idle period, the next mid-turn
  // calls have nothing to record. This keeps them free of state reads.
  let idleEnded = false;
  return {
    wrap:
      (base = streamSimple) =>
      (model, context, options) => {
        // With warming off, Pi's own retention applies.
        const cacheRetention =
          options?.cacheRetention ??
          (getChatConfig().cacheWarmingEnabled ? CACHE_RETENTION : undefined);
        lastRequest = {
          model,
          // Copy the list, so later changes to the run do not change it.
          context: { ...context, messages: [...context.messages] },
          ...(options?.reasoning
            ? { reasoning: options.reasoning }
            : undefined),
          ...(cacheRetention ? { cacheRetention } : undefined),
          startedAtMs: Date.now(),
        };
        return base(
          model,
          context,
          cacheRetention ? { ...options, cacheRetention } : options,
        );
      },
    record: async (message) => {
      const request = lastRequest;
      lastRequest = undefined;
      if (
        !getChatConfig().cacheWarmingEnabled ||
        !request ||
        message.stopReason === "error" ||
        message.stopReason === "aborted" ||
        (idleEnded && message.stopReason !== "stop")
      ) {
        return;
      }
      idleEnded = message.stopReason !== "stop";
      try {
        await recordModelCall(conversationId, userActor, request, message);
      } catch (error) {
        logWarn("cache_warming.model_call.record_failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

// Count one warmup outcome. Open the breaker when too many recent warmups
// missed. Only the call that opens it reports to Sentry.
async function countOutcome(
  state: ConnectedState,
  modelId: string,
  miss: boolean,
): Promise<void> {
  const provider = providerOf(modelId);
  await state.appendToList(breakerOutcomesKey(provider), miss ? 1 : 0, {
    maxLength: BREAKER_OUTCOMES_MAX,
    ttlMs: BREAKER_OUTCOMES_TTL_MS,
  });
  if (!miss) return;
  const outcomes = await state.getList<number>(breakerOutcomesKey(provider));
  const misses = outcomes.filter((outcome) => outcome === 1).length;
  if (
    misses >= BREAKER_MAX_MISSES &&
    (await state.setIfNotExists(
      breakerOpenKey(provider),
      true,
      BREAKER_OPEN_TTL_MS,
    ))
  ) {
    captureMessage("Cache warming stopped: too many warmups missed the cache", {
      level: "error",
      fingerprint: ["cache_warming.breaker.opened", provider],
      tags: { "gen_ai.request.model": modelId },
      extra: {
        "app.cache_warming.misses": misses,
        "app.cache_warming.outcomes": outcomes.length,
      },
    });
  }
}

/**
 * Run one scheduled cache warming message. A message for an idle period that
 * already ended does nothing.
 */
export async function runCacheWarmup(
  message: CacheWarmupMessage,
): Promise<void> {
  const { conversationId } = message;
  const state = await connectedState();
  const current = await state.get<ConversationCacheState>(
    conversationKey(conversationId),
  );
  const idle = current?.idle;
  const warm = idle?.warm;
  if (!idle || !warm || idle.generation !== message.generation) {
    return;
  }
  const { generation } = idle;
  const stop = () => state.delete(snapshotKey(conversationId, generation));

  if (message.kind === "horizon") {
    await stop();
    await recordGap(state, conversationId, idle, NO_REPLY_GAP_MS);
    return;
  }
  const warmups =
    (await state.get<number>(warmupsKey(conversationId, generation))) ?? 0;
  if (warmups !== message.cycle - 1) {
    return;
  }

  await runWithLogContext(
    { conversationId, modelId: warm.modelId },
    {},
    async () => {
      const attributes: Record<string, unknown> = {
        "app.cache_warming.cycle": message.cycle,
        "app.cache_warming.prefix_tokens": warm.prefixTokens,
        // Queue delay shows as a smaller time left than the warmup margin.
        "app.cache_warming.cache_ttl_left_ms":
          message.cacheExpiresAtMs - Date.now(),
      };
      // The queue can deliver a warmup late, or a long Turn can leave no time
      // before the cache expires. The cache is gone, so this is not a miss.
      if (Date.now() + LATE_WARMUP_MS >= message.cacheExpiresAtMs) {
        logInfo("cache_warming.warmup.skipped", {
          ...attributes,
          "app.cache_warming.skip_reason": "cache_expired",
        });
        await stop();
        return;
      }
      if (await state.get<boolean>(breakerOpenKey(providerOf(warm.modelId)))) {
        logInfo("cache_warming.warmup.skipped", {
          ...attributes,
          "app.cache_warming.skip_reason": "breaker_open",
        });
        await stop();
        return;
      }

      const model = resolveGatewayModel(warm.modelId);
      const decision = decideWarmup({
        conversationGapsMs: await state.getList<number>(
          conversationGapsKey(conversationId),
        ),
        globalGapsMs: await state.getList<number>(segmentGapsKey(idle.segment)),
        idleMs: Date.now() - idle.sinceMs,
        cacheTtlMs: warm.cacheTtlMs,
        prefixTokens: warm.prefixTokens,
        cacheReadPrice: model.cost.cacheRead,
        cacheWritePrice: model.cost.cacheWrite,
      });
      attributes["app.cache_warming.return_probability"] =
        decision.returnProbability;
      attributes["app.cache_warming.threshold"] = decision.threshold;
      if (!decision.warm) {
        logInfo("cache_warming.warmup.skipped", {
          ...attributes,
          "app.cache_warming.skip_reason": decision.reason,
        });
        await stop();
        return;
      }

      // Warming stopped, or the idle period ended.
      const snapshot = await state.get<string>(
        snapshotKey(conversationId, generation),
      );
      if (!snapshot) {
        return;
      }
      const context = JSON.parse(
        (await gunzip(Buffer.from(snapshot, "base64"))).toString("utf8"),
      ) as Context;
      const startedAtMs = Date.now();
      const { message: result } = await completeText({
        modelId: warm.modelId,
        system: context.systemPrompt,
        messages: context.messages,
        ...(context.tools ? { tools: context.tools } : undefined),
        ...(warm.reasoning ? { thinkingLevel: warm.reasoning } : undefined),
        cacheRetention: CACHE_RETENTION,
        // The output is not used.
        maxTokens: 1,
        messageAttributeMode: "metadata",
        metadata: { conversationId },
        operation: "cache_warmup",
        cost: { conversationId },
        // Use the agent's gateway session, so the warmup reaches the same cache.
        sessionId: conversationId,
      }).catch(async (error: unknown) => {
        // A request that the provider rejects fails the same way for each
        // Conversation. Count it, so the breaker stops these requests.
        await countOutcome(state, warm.modelId, true);
        await stop();
        throw error;
      });
      Object.assign(attributes, {
        "app.cost.total_usd": result.usage.cost.total,
        "gen_ai.usage.cache_read.input_tokens": result.usage.cacheRead,
        "gen_ai.usage.cache_creation.input_tokens": result.usage.cacheWrite,
      });

      if (
        result.usage.cacheRead <
        warm.prefixTokens * REFRESHED_READ_FRACTION
      ) {
        // The request did not match the cached prefix, so it wrote a new
        // cache entry. Stop this idle period and count the miss.
        logWarn("cache_warming.warmup.failed", attributes);
        captureMessage("Cache warmup missed the cache", {
          level: "warning",
          fingerprint: ["cache_warming.warmup.missed", warm.modelId],
          tags: { "gen_ai.request.model": warm.modelId },
          extra: {
            "app.cache_warming.read_fraction":
              result.usage.cacheRead / warm.prefixTokens,
          },
        });
        await countOutcome(state, warm.modelId, true);
        await stop();
        return;
      }
      await countOutcome(state, warm.modelId, false);
      logInfo("cache_warming.warmup.completed", attributes);

      await state.set(
        warmupsKey(conversationId, generation),
        message.cycle,
        IDLE_HORIZON_MS,
      );
      // A reply during the warmup ended the idle period and deleted its
      // snapshot. Then the next warmup would do nothing.
      if (await state.get<string>(snapshotKey(conversationId, generation))) {
        await scheduleWarmup(
          {
            kind: "warmup",
            conversationId,
            cycle: message.cycle + 1,
            generation,
          },
          startedAtMs,
          warm,
        );
      }
    },
  );
}
