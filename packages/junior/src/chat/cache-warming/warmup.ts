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
 */
import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  streamSimple,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai/compat";
import { runWithLogContext } from "@/chat/log-context";
import { logInfo, logWarn } from "@/chat/logging";
import { completeText, resolveGatewayModel } from "@/chat/pi/client";
import type { ThinkingLevel } from "@/chat/pi/sdk";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  decideWarmup,
  IDLE_HORIZON_MS,
  MIN_WARMUP_PREFIX_TOKENS,
  NO_REPLY_GAP_MS,
  SHORT_CACHE_TTL_MS,
  warmupMarginMs,
} from "./model";
import { sendCacheWarmup, type CacheWarmupMessage } from "./queue";

const KEY_PREFIX = "junior:cache_warming";
const GLOBAL_GAPS_KEY = `${KEY_PREFIX}:gaps`;
const GLOBAL_GAPS_MAX = 2_000;
const GLOBAL_GAPS_TTL_MS = 30 * 24 * 60 * 60_000;
const CONVERSATION_GAPS_MAX = 50;
const CONVERSATION_STATE_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
// A refreshed prefix reads almost all of the stored prefix from the cache.
const REFRESHED_READ_FRACTION = 0.9;
// One miss costs about one cache write, which is (write / read) warmups. So
// the breaker opens at a low miss count among the recent warmups of a model.
// A success does not reset it. The list expires after a quiet period.
const BREAKER_OUTCOMES_MAX = 20;
const BREAKER_MAX_MISSES = 3;
const BREAKER_TTL_MS = 6 * 60 * 60_000;

interface WarmState {
  modelId: string;
  prefixTokens: number;
  reasoning?: ThinkingLevel;
  warmups: number;
  /** False after warmups stop. The snapshot is then deleted. */
  active: boolean;
}

interface IdlePeriod {
  generation: string;
  /** Start of the request that ended the turn. */
  sinceMs: number;
  /** True after this period recorded its gap. */
  gapRecorded?: boolean;
  /** Only periods that could be warmed record gaps. */
  warm?: WarmState;
}

interface ConversationCacheState {
  /** Recent reply gaps (ms) of the idle periods of this Conversation. */
  gapsMs: number[];
  idle?: IdlePeriod;
}

interface ModelRequest {
  model: Model<Api>;
  context: Context;
  reasoning?: ThinkingLevel;
  startedAtMs: number;
}

const conversationKey = (conversationId: string) =>
  `${KEY_PREFIX}:conversation:${conversationId}`;
const snapshotKey = (conversationId: string) =>
  `${KEY_PREFIX}:snapshot:${conversationId}`;
const breakerKey = (modelId: string) => `${KEY_PREFIX}:breaker:${modelId}`;

async function connectedState() {
  const state = getStateAdapter();
  await state.connect();
  return state;
}

// Only Anthropic models have the 5 minute cache TTL that the model assumes.
// Other providers on the Anthropic Messages API cache in other ways.
// Budget thinking adds the thinking budget to the one-token output limit, so
// a warmup could cost as much as a short answer. Adaptive thinking does not.
function supportsWarming(
  model: Model<Api>,
  reasoning: ThinkingLevel | undefined,
): boolean {
  return (
    model.api === "anthropic-messages" &&
    model.id.startsWith("anthropic/") &&
    model.cost.cacheRead > 0 &&
    model.cost.cacheWrite > model.cost.cacheRead &&
    (!reasoning ||
      (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking ===
        true) &&
    // Long retention keeps the cache for an hour, so warmups are not needed.
    process.env.PI_CACHE_RETENTION !== "long"
  );
}

function nextWarmupDelayMs(
  requestStartedAtMs: number,
  prefixTokens: number,
): number {
  return (
    requestStartedAtMs +
    SHORT_CACHE_TTL_MS -
    warmupMarginMs(prefixTokens) -
    Date.now()
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

async function recordGap(
  state: Awaited<ReturnType<typeof connectedState>>,
  gapsMs: number[],
  gapMs: number,
): Promise<number[]> {
  await state.appendToList(GLOBAL_GAPS_KEY, gapMs, {
    maxLength: GLOBAL_GAPS_MAX,
    ttlMs: GLOBAL_GAPS_TTL_MS,
  });
  return [...gapsMs, gapMs].slice(-CONVERSATION_GAPS_MAX);
}

async function startIdlePeriod(
  state: Awaited<ReturnType<typeof connectedState>>,
  conversationId: string,
  request: ModelRequest,
  message: AssistantMessage,
): Promise<IdlePeriod> {
  const idle: IdlePeriod = {
    generation: randomUUID(),
    sinceMs: request.startedAtMs,
  };
  const prefixTokens = message.usage.cacheRead + message.usage.cacheWrite;
  if (
    !supportsWarming(request.model, request.reasoning) ||
    prefixTokens < MIN_WARMUP_PREFIX_TOKENS
  ) {
    return idle;
  }
  const snapshot = gzipSync(
    JSON.stringify(snapshotContext(request.context)),
  ).toString("base64");
  if (snapshot.length > MAX_SNAPSHOT_BYTES) {
    logInfo("cache_warming.snapshot.skipped", {
      "app.cache_warming.prefix_tokens": prefixTokens,
      "app.cache_warming.snapshot_bytes": snapshot.length,
    });
    return idle;
  }
  await state.set(snapshotKey(conversationId), snapshot, IDLE_HORIZON_MS);
  return {
    ...idle,
    warm: {
      modelId: request.model.id,
      prefixTokens,
      ...(request.reasoning ? { reasoning: request.reasoning } : undefined),
      warmups: 0,
      active: true,
    },
  };
}

async function recordModelCall(
  conversationId: string,
  request: ModelRequest,
  message: AssistantMessage,
): Promise<void> {
  const state = await connectedState();
  const previous = await state.get<ConversationCacheState>(
    conversationKey(conversationId),
  );
  let gapsMs = previous?.gapsMs ?? [];
  const idle = previous?.idle;
  if (idle) {
    const gapMs = request.startedAtMs - idle.sinceMs;
    if (idle.warm && !idle.gapRecorded && gapMs > 0) {
      gapsMs = await recordGap(state, gapsMs, gapMs);
    }
    if (idle.warm?.active) {
      await state.delete(snapshotKey(conversationId));
    }
    if (idle.warm && idle.warm.warmups > 0) {
      logInfo("cache_warming.conversation.returned", {
        "app.cache_warming.gap_ms": gapMs,
        "app.cache_warming.prefix_tokens": idle.warm.prefixTokens,
        "app.cache_warming.warmup_count": idle.warm.warmups,
        "gen_ai.usage.cache_read.input_tokens": message.usage.cacheRead,
        "gen_ai.usage.cache_creation.input_tokens": message.usage.cacheWrite,
      });
    }
  }

  // Mid-turn calls arrive seconds apart. Only the call that ends a turn
  // starts an idle period.
  const next: ConversationCacheState =
    message.stopReason === "stop"
      ? {
          gapsMs,
          idle: await startIdlePeriod(state, conversationId, request, message),
        }
      : { gapsMs };
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
    await sendCacheWarmup(
      { kind: "warmup", conversationId, cycle: 1, generation },
      nextWarmupDelayMs(request.startedAtMs, next.idle.warm.prefixTokens),
    );
    await sendCacheWarmup(
      { kind: "horizon", conversationId, generation },
      request.startedAtMs + IDLE_HORIZON_MS - Date.now(),
    );
  }
}

/** Records the model calls of one agent run and schedules cache warmups. */
export interface CacheWarmingRecorder {
  /** Wrap the stream function so the recorder sees each model request. */
  wrap(base?: StreamFn): StreamFn;
  /** Record the finished assistant message of the last model request. */
  record(message: AssistantMessage): Promise<void>;
}

/**
 * Create a recorder for one agent run. A failure to record only loses cache
 * warming, so it is logged and does not stop the run.
 */
export function createCacheWarmingRecorder(
  conversationId: string,
): CacheWarmingRecorder {
  let lastRequest: ModelRequest | undefined;
  // After the first call of the run ends the idle period, the next mid-turn
  // calls have nothing to record. This keeps them free of state reads.
  let idleEnded = false;
  return {
    wrap:
      (base = streamSimple) =>
      (model, context, options) => {
        lastRequest = {
          model,
          // Copy the list, so later changes to the run do not change it.
          context: { ...context, messages: [...context.messages] },
          ...(options?.reasoning
            ? { reasoning: options.reasoning }
            : undefined),
          startedAtMs: Date.now(),
        };
        return base(model, context, options);
      },
    record: async (message) => {
      const request = lastRequest;
      lastRequest = undefined;
      if (
        !request ||
        message.stopReason === "error" ||
        message.stopReason === "aborted" ||
        (idleEnded && message.stopReason !== "stop")
      ) {
        return;
      }
      idleEnded = message.stopReason !== "stop";
      try {
        await recordModelCall(conversationId, request, message);
      } catch (error) {
        logWarn("cache_warming.model_call.record_failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

async function breakerOpen(modelId: string): Promise<boolean> {
  const state = await connectedState();
  const outcomes = await state.getList<number>(breakerKey(modelId));
  return outcomes.filter((miss) => miss === 1).length >= BREAKER_MAX_MISSES;
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
  if (!current || !idle || !warm || idle.generation !== message.generation) {
    return;
  }

  // Write only when a real model call did not replace the idle period.
  const update = async (changes: Partial<IdlePeriod>, gapsMs?: number[]) => {
    const latest = await state.get<ConversationCacheState>(
      conversationKey(conversationId),
    );
    if (latest?.idle?.generation !== message.generation) {
      return false;
    }
    await state.set(
      conversationKey(conversationId),
      {
        gapsMs: gapsMs ?? latest.gapsMs,
        idle: { ...latest.idle, ...changes },
      } satisfies ConversationCacheState,
      CONVERSATION_STATE_TTL_MS,
    );
    return true;
  };
  const stop = async () => {
    await state.delete(snapshotKey(conversationId));
    await update({ warm: { ...warm, active: false } });
  };

  if (message.kind === "horizon") {
    if (!idle.gapRecorded) {
      await state.delete(snapshotKey(conversationId));
      await update(
        { gapRecorded: true, warm: { ...warm, active: false } },
        await recordGap(state, current.gapsMs, NO_REPLY_GAP_MS),
      );
    }
    return;
  }
  if (!warm.active || warm.warmups !== message.cycle - 1) {
    return;
  }

  await runWithLogContext(
    { conversationId, modelId: warm.modelId },
    {},
    async () => {
      const attributes: Record<string, unknown> = {
        "app.cache_warming.cycle": message.cycle,
        "app.cache_warming.prefix_tokens": warm.prefixTokens,
      };
      if (await breakerOpen(warm.modelId)) {
        logInfo("cache_warming.warmup.skipped", {
          ...attributes,
          "app.cache_warming.skip_reason": "breaker_open",
        });
        await stop();
        return;
      }

      const model = resolveGatewayModel(warm.modelId);
      const decision = decideWarmup({
        conversationGapsMs: current.gapsMs,
        globalGapsMs: await state.getList<number>(GLOBAL_GAPS_KEY),
        idleMs: Date.now() - idle.sinceMs,
        cycle: message.cycle,
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

      const snapshot = await state.get<string>(snapshotKey(conversationId));
      if (!snapshot) {
        await stop();
        return;
      }
      const context = JSON.parse(
        gunzipSync(Buffer.from(snapshot, "base64")).toString("utf8"),
      ) as Context;
      const startedAtMs = Date.now();
      const countOutcome = (miss: boolean) =>
        state.appendToList(breakerKey(warm.modelId), miss ? 1 : 0, {
          maxLength: BREAKER_OUTCOMES_MAX,
          ttlMs: BREAKER_TTL_MS,
        });
      const { message: result } = await completeText({
        modelId: warm.modelId,
        system: context.systemPrompt,
        messages: context.messages,
        ...(context.tools ? { tools: context.tools } : undefined),
        ...(warm.reasoning ? { thinkingLevel: warm.reasoning } : undefined),
        // The output is not used.
        maxTokens: 1,
        messageAttributeMode: "metadata",
        metadata: { conversationId },
        promptName: "cache_warmup",
      }).catch(async (error: unknown) => {
        // A request that the provider rejects fails the same way for each
        // Conversation. Count it, so the breaker stops these requests.
        await countOutcome(true);
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
        // cache entry. Stop this idle period and count the miss for the model.
        await countOutcome(true);
        logWarn("cache_warming.warmup.failed", attributes);
        await stop();
        return;
      }
      await countOutcome(false);
      logInfo("cache_warming.warmup.completed", attributes);

      if (await update({ warm: { ...warm, warmups: message.cycle } })) {
        await sendCacheWarmup(
          { ...message, cycle: message.cycle + 1 },
          nextWarmupDelayMs(startedAtMs, warm.prefixTokens),
        );
      }
    },
  );
}
