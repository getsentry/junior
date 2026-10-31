/**
 * Prompt cache warming for idle Conversations.
 *
 * After a turn ends, the next human message often arrives after the short
 * prompt cache TTL. Then the full history is written to the cache again. A
 * warmup sends the same request again with a one-token output limit before
 * the cache expires. The provider reads the cached prefix and refreshes its
 * TTL. `model.ts` owns the cost model.
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
  MIN_WARMUP_PREFIX_TOKENS,
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
// The rising threshold stops warming after (write - read) / read cycles. That
// is 24 cycles (about 1.5 hours) at Anthropic prices.
const SNAPSHOT_TTL_MS = 2 * 60 * 60_000;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
// A refreshed prefix reads almost all of the stored prefix from the cache.
const REFRESHED_READ_FRACTION = 0.9;
// Warmups for one model stop for a while after this many misses in a row.
const BREAKER_MAX_MISSES = 3;
const BREAKER_TTL_MS = 6 * 60 * 60_000;

interface WarmState {
  generation: string;
  modelId: string;
  prefixTokens: number;
  reasoning?: ThinkingLevel;
  warmups: number;
}

interface ConversationCacheState {
  /** Recent human gaps (ms) between a finished turn and the next model call. */
  gapsMs: number[];
  /** Start of the request that ended the last turn, while no new call came. */
  idleSinceMs?: number;
  warm?: WarmState;
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

function supportsWarming(model: Model<Api>): boolean {
  return (
    model.api === "anthropic-messages" &&
    model.cost.cacheRead > 0 &&
    model.cost.cacheWrite > model.cost.cacheRead &&
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
  if (previous?.idleSinceMs !== undefined) {
    const gapMs = request.startedAtMs - previous.idleSinceMs;
    if (gapMs > 0) {
      gapsMs = [...gapsMs, gapMs].slice(-CONVERSATION_GAPS_MAX);
      await state.appendToList(GLOBAL_GAPS_KEY, gapMs, {
        maxLength: GLOBAL_GAPS_MAX,
        ttlMs: GLOBAL_GAPS_TTL_MS,
      });
    }
    if (previous.warm && previous.warm.warmups > 0) {
      logInfo("cache_warming.conversation.returned", {
        "app.cache_warming.gap_ms": gapMs,
        "app.cache_warming.prefix_tokens": previous.warm.prefixTokens,
        "app.cache_warming.warmup_count": previous.warm.warmups,
        "gen_ai.usage.cache_read.input_tokens": message.usage.cacheRead,
        "gen_ai.usage.cache_creation.input_tokens": message.usage.cacheWrite,
      });
    }
  }

  const endsTurn = message.stopReason === "stop";
  if (!endsTurn) {
    // Mid-turn calls arrive seconds apart. Only the first call after an idle
    // period changes the stored state.
    if (previous?.idleSinceMs !== undefined) {
      await state.set(
        conversationKey(conversationId),
        { gapsMs } satisfies ConversationCacheState,
        CONVERSATION_STATE_TTL_MS,
      );
      await state.delete(snapshotKey(conversationId));
    }
    return;
  }

  const prefixTokens = message.usage.cacheRead + message.usage.cacheWrite;
  const next: ConversationCacheState = {
    gapsMs,
    idleSinceMs: request.startedAtMs,
  };
  if (
    supportsWarming(request.model) &&
    prefixTokens >= MIN_WARMUP_PREFIX_TOKENS
  ) {
    const snapshot = gzipSync(
      JSON.stringify(snapshotContext(request.context)),
    ).toString("base64");
    if (snapshot.length <= MAX_SNAPSHOT_BYTES) {
      next.warm = {
        generation: randomUUID(),
        modelId: request.model.id,
        prefixTokens,
        ...(request.reasoning ? { reasoning: request.reasoning } : undefined),
        warmups: 0,
      };
      await state.set(snapshotKey(conversationId), snapshot, SNAPSHOT_TTL_MS);
    } else {
      logInfo("cache_warming.snapshot.skipped", {
        "app.cache_warming.prefix_tokens": prefixTokens,
        "app.cache_warming.snapshot_bytes": snapshot.length,
      });
    }
  }
  await state.set(
    conversationKey(conversationId),
    next,
    CONVERSATION_STATE_TTL_MS,
  );
  if (!next.warm && previous?.warm) {
    await state.delete(snapshotKey(conversationId));
  }
  if (next.warm) {
    await sendCacheWarmup(
      { conversationId, cycle: 1, generation: next.warm.generation },
      nextWarmupDelayMs(request.startedAtMs, prefixTokens),
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
        message.stopReason === "aborted"
      ) {
        return;
      }
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
  const misses = await state.getList(breakerKey(modelId));
  return misses.length >= BREAKER_MAX_MISSES;
}

/** Run one scheduled warmup. A stale message, for a newer call, does nothing. */
export async function runCacheWarmup(
  message: CacheWarmupMessage,
): Promise<void> {
  const { conversationId } = message;
  const state = await connectedState();
  const current = await state.get<ConversationCacheState>(
    conversationKey(conversationId),
  );
  const warm = current?.warm;
  if (
    !current ||
    current.idleSinceMs === undefined ||
    !warm ||
    warm.generation !== message.generation ||
    warm.warmups !== message.cycle - 1
  ) {
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
        return;
      }

      const model = resolveGatewayModel(warm.modelId);
      const decision = decideWarmup({
        conversationGapsMs: current.gapsMs,
        globalGapsMs: await state.getList<number>(GLOBAL_GAPS_KEY),
        idleMs: Date.now() - current.idleSinceMs!,
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
        return;
      }

      const snapshot = await state.get<string>(snapshotKey(conversationId));
      if (!snapshot) {
        return;
      }
      const context = JSON.parse(
        gunzipSync(Buffer.from(snapshot, "base64")).toString("utf8"),
      ) as Context;
      const startedAtMs = Date.now();
      const countMiss = () =>
        state.appendToList(breakerKey(warm.modelId), startedAtMs, {
          maxLength: BREAKER_MAX_MISSES,
          ttlMs: BREAKER_TTL_MS,
        });
      const { message: result } = await completeText({
        modelId: warm.modelId,
        system: context.systemPrompt,
        messages: context.messages,
        ...(context.tools ? { tools: context.tools } : undefined),
        ...(warm.reasoning ? { thinkingLevel: warm.reasoning } : undefined),
        // The output is not used. One token keeps it valid with thinking on.
        maxTokens: 1,
        messageAttributeMode: "metadata",
        metadata: { conversationId },
        promptName: "cache_warmup",
      }).catch(async (error: unknown) => {
        // A request that the provider rejects fails the same way for each
        // Conversation. Count it, so the breaker stops these requests.
        await countMiss();
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
        await countMiss();
        logWarn("cache_warming.warmup.failed", attributes);
        return;
      }
      await state.delete(breakerKey(warm.modelId));
      logInfo("cache_warming.warmup.completed", attributes);

      // A real model call may have replaced the state during the warmup.
      const latest = await state.get<ConversationCacheState>(
        conversationKey(conversationId),
      );
      if (latest?.warm?.generation !== message.generation) {
        return;
      }
      await state.set(
        conversationKey(conversationId),
        {
          ...latest,
          warm: { ...latest.warm, warmups: message.cycle },
        } satisfies ConversationCacheState,
        CONVERSATION_STATE_TTL_MS,
      );
      await sendCacheWarmup(
        { ...message, cycle: message.cycle + 1 },
        nextWarmupDelayMs(startedAtMs, warm.prefixTokens),
      );
    },
  );
}
