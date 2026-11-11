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
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  streamSimple,
  type AssistantMessage,
} from "@earendil-works/pi-ai/compat";
import type { Platform } from "@sentry/junior-plugin-api";
import { getChatConfig } from "@/chat/config";
import { logInfo, logWarn, withSpan } from "@/chat/logging";
import { resolveGatewayModel } from "@/chat/pi/client";
import { metrics } from "@/chat/sentry";
import type { ThinkingLevel } from "@/chat/pi/sdk";
import {
  buildDeploymentSystemPrompt,
  systemPromptHash,
} from "@/chat/system-prompt";
import type { PromptMode } from "@/chat/system-prompt-rules";
import {
  decideWarmup,
  gapSegment,
  IDLE_HORIZON_MS,
  MINUTE_MS,
  MIN_WARMUP_PREFIX_TOKENS,
  NO_REPLY_GAP_MS,
  parentGapSegment,
  segmentNeedsParent,
  type GapSegmentInput,
  type WorkState,
} from "./model";
import { sendCacheWarmup, type CacheWarmupMessage } from "./queue";
import {
  breakerOpen,
  CACHE_RETENTION,
  cachedPrefixTokens,
  connectedState,
  KEY_PREFIX,
  sendWarmup,
  cacheTtlMs,
  warmupTiming,
  warmupTooLate,
  type ConnectedState,
  type ModelRequest,
} from "./request";
import { loadSnapshot, saveSnapshot, type SnapshotSize } from "./snapshot";
import { createToolWaitWarmer } from "./tool-wait";
import { readSegmentState } from "./work-state";

/** Gaps kept in each segment list. */
export const GLOBAL_GAPS_MAX = 2_000;
/** A segment list expires this long after its last gap. */
export const GLOBAL_GAPS_TTL_MS = 30 * 24 * 60 * MINUTE_MS;
const CONVERSATION_GAPS_MAX = 50;
/** The Turn count of a Conversation resets after this long with no call. */
export const CONVERSATION_STATE_TTL_MS = 7 * 24 * 60 * MINUTE_MS;
/** How the Turn before an idle period ended. */
type TurnEnding = "reply" | "no_reply";

/** Warming stops when the snapshot of the idle period is deleted. */
interface WarmState {
  /** The `gapSegment` that this period records its gap in. */
  segment: string;
  /** Unset in idle periods from before it was stored. */
  turnEnding?: TurnEnding;
  /** The `parentGapSegment` that a thin `segment` leans on. */
  parentSegment?: string;
  /**
   * The system prompt of the snapshot. Unset in snapshots from before it was
   * stored; those warm without the check.
   */
  systemPrompt?: SystemPromptKey & { hash: string };
  workState: WorkState;
  archived: boolean;
  modelId: string;
  prefixTokens: number;
  cacheTtlMs: number;
  reasoning?: ThinkingLevel;
  /** Unset in idle periods from before it was stored. */
  snapshot?: SnapshotSize;
}

interface IdlePeriod {
  generation: string;
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

/** State list of the recent reply gaps (ms) of one `gapSegment`. */
export const segmentGapsKey = (segment: string) =>
  `${KEY_PREFIX}:gaps:${segment}`;
const conversationKey = (conversationId: string) =>
  `${KEY_PREFIX}:conversation:${conversationId}`;
/**
 * Recent reply gaps (ms) of the idle periods of this Conversation, per
 * `gapSegment`. A person's quick replies must not set the return chance of an
 * idle period that a system Turn started.
 */
const conversationGapsKey = (conversationId: string, segment: string) =>
  `${KEY_PREFIX}:gaps:conversation:${conversationId}:${segment}`;
const snapshotKey = (conversationId: string, generation: string) =>
  `${KEY_PREFIX}:snapshot:${conversationId}:${generation}`;
/** Warmups that completed in the idle period. */
const warmupsKey = (conversationId: string, generation: string) =>
  `${KEY_PREFIX}:warmups:${conversationId}:${generation}`;
/** Set by the first of the reply and the horizon to record the gap. */
const gapClaimKey = (conversationId: string, generation: string) =>
  `${KEY_PREFIX}:gap_claim:${conversationId}:${generation}`;
const segmentAttributes = (warm: WarmState) => ({
  "app.cache_warming.work_state": warm.workState,
  "app.cache_warming.archived": warm.archived,
  ...(warm.turnEnding
    ? { "app.cache_warming.turn_ending": warm.turnEnding }
    : undefined),
});
const snapshotAttributes = (size: SnapshotSize) => ({
  "app.cache_warming.snapshot_bytes": size.bytes,
  "app.cache_warming.snapshot_image_count": size.imageCount,
  "app.cache_warming.snapshot_image_bytes": size.imageBytes,
});

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
  const { cacheExpiresAtMs, delayMs } = warmupTiming(
    requestStartedAtMs,
    warm.cacheTtlMs,
  );
  await sendCacheWarmup({ ...message, cacheExpiresAtMs }, delayMs);
}

// The reply and the horizon can run at the same time. Only the first one to
// claim the idle period records its gap.
async function recordGap(
  state: ConnectedState,
  conversationId: string,
  generation: string,
  warm: WarmState,
  gapMs: number,
): Promise<void> {
  const claimed = await state.setIfNotExists(
    gapClaimKey(conversationId, generation),
    true,
    CONVERSATION_STATE_TTL_MS,
  );
  if (!claimed) {
    return;
  }
  await state.appendToList(segmentGapsKey(warm.segment), gapMs, {
    maxLength: GLOBAL_GAPS_MAX,
    ttlMs: GLOBAL_GAPS_TTL_MS,
  });
  await state.appendToList(
    conversationGapsKey(conversationId, warm.segment),
    gapMs,
    {
      maxLength: CONVERSATION_GAPS_MAX,
      ttlMs: CONVERSATION_STATE_TTL_MS,
    },
  );
}

async function startIdlePeriod(
  state: ConnectedState,
  conversationId: string,
  request: ModelRequest,
  message: AssistantMessage,
  turn: Pick<GapSegmentInput, "userActor" | "endedTurns">,
  systemPrompt: SystemPromptKey,
  turnEnding: TurnEnding,
): Promise<IdlePeriod> {
  const idle: IdlePeriod = {
    generation: randomUUID(),
    sinceMs: request.startedAtMs,
  };
  const prefixTokens = cachedPrefixTokens(message);
  const ttlMs = cacheTtlMs(request);
  if (ttlMs === undefined || prefixTokens < MIN_WARMUP_PREFIX_TOKENS) {
    return idle;
  }
  const { stored, ...snapshot } = await saveSnapshot(
    state,
    conversationId,
    snapshotKey(conversationId, idle.generation),
    request.context,
    IDLE_HORIZON_MS,
  );
  // Spans are sampled. These metrics show the size distribution of every
  // snapshot, so the limit can be tuned.
  const metricOptions = {
    unit: "byte",
    attributes: { "app.cache_warming.stored": stored },
  };
  metrics.distribution(
    "cache_warming.snapshot.bytes",
    snapshot.bytes,
    metricOptions,
  );
  metrics.distribution(
    "cache_warming.snapshot.image_bytes",
    snapshot.imageBytes,
    metricOptions,
  );
  if (!stored) {
    // A warning, so production keeps this idle period that Junior cannot warm.
    logWarn("cache_warming.snapshot.skipped", {
      "app.cache_warming.skip_reason": "snapshot_too_large",
      "app.cache_warming.prefix_tokens": prefixTokens,
      ...snapshotAttributes(snapshot),
    });
    return idle;
  }
  // Read here, not on each model call: only a period that Junior can warm
  // records a gap.
  const segmentState = await readSegmentState(conversationId, Date.now());
  const segmentInput = { ...turn, ...segmentState };
  const parentSegment = parentGapSegment(segmentInput);
  return {
    ...idle,
    warm: {
      segment: gapSegment(segmentInput),
      turnEnding,
      ...(parentSegment ? { parentSegment } : undefined),
      ...(request.context.systemPrompt !== undefined
        ? {
            systemPrompt: {
              ...systemPrompt,
              hash: systemPromptHash(request.context.systemPrompt),
            },
          }
        : undefined),
      ...segmentState,
      modelId: request.model.id,
      prefixTokens,
      cacheTtlMs: ttlMs,
      ...(request.reasoning ? { reasoning: request.reasoning } : undefined),
      snapshot,
    },
  };
}

async function recordModelCall(
  conversationId: string,
  userActor: boolean,
  systemPrompt: SystemPromptKey,
  request: ModelRequest,
  message: AssistantMessage,
  turnEnding: TurnEnding | undefined,
): Promise<void> {
  const state = await connectedState();
  const previous = await state.get<ConversationCacheState>(
    conversationKey(conversationId),
  );
  const idle = previous?.idle;
  if (idle?.warm) {
    const gapMs = request.startedAtMs - idle.sinceMs;
    if (gapMs > 0) {
      await recordGap(state, conversationId, idle.generation, idle.warm, gapMs);
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
        ...segmentAttributes(idle.warm),
        "gen_ai.usage.cache_read.input_tokens": message.usage.cacheRead,
        "gen_ai.usage.cache_creation.input_tokens": message.usage.cacheWrite,
      });
    }
  }

  // Mid-turn calls arrive seconds apart. Only the call that ends a turn
  // starts an idle period.
  const endedTurns = previous?.endedTurns ?? 0;
  const next: ConversationCacheState = turnEnding
    ? {
        endedTurns: endedTurns + 1,
        idle: await startIdlePeriod(
          state,
          conversationId,
          request,
          message,
          { userActor, endedTurns },
          systemPrompt,
          turnEnding,
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
    // Send the horizon first: a failed warmup send must not leave the idle
    // period without its no-reply gap.
    await sendCacheWarmup(
      { kind: "horizon", conversationId, generation },
      request.startedAtMs + IDLE_HORIZON_MS - Date.now(),
    );
    await scheduleWarmup(
      { kind: "warmup", conversationId, cycle: 1, generation },
      request.startedAtMs,
      next.idle.warm,
    );
  }
}

// A run's first request ends the idle period of the last Turn. Delete its
// snapshot when that request starts, so a warmup that comes due during the
// request sends nothing. `record` ends the idle period when the call is done.
async function stopIdleWarmups(conversationId: string): Promise<void> {
  try {
    const state = await connectedState();
    const idle = (
      await state.get<ConversationCacheState>(conversationKey(conversationId))
    )?.idle;
    if (idle?.warm) {
      await state.delete(snapshotKey(conversationId, idle.generation));
    }
  } catch (error) {
    logWarn("cache_warming.idle_period.stop_failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
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
  /** Mark that the tools of the last request returned. */
  toolsReturned(): void;
  /**
   * Mark that a `noReply` call of the last request ended the run. Then `stop`
   * starts the idle period from that request, as a final response would.
   */
  noReplyEnded(): void;
  /** Stop the warmups of this run. Call it when the run ends. */
  stop(): Promise<void>;
}

/**
 * Platform and Prompt mode of a run's system prompt. With the deployment,
 * they set the system prompt text.
 */
export interface SystemPromptKey {
  platform: Platform;
  mode: PromptMode;
}

/**
 * Create a recorder for one agent run. `userActor` is true when a person
 * started the Turn. A failure to record only loses cache warming, so it is
 * logged and does not stop the run.
 */
export function createCacheWarmingRecorder(
  conversationId: string,
  userActor: boolean,
  systemPrompt: SystemPromptKey,
): CacheWarmingRecorder {
  let lastRequest: ModelRequest | undefined;
  // The last finished call, for an idle period that `noReply` starts.
  let lastCall:
    | { request: ModelRequest; message: AssistantMessage }
    | undefined;
  let noReplyEnded = false;
  // After the first call of the run ends the idle period, the next mid-turn
  // calls have nothing to record. This keeps them free of state reads.
  let idleEnded = false;
  let warmupsStopped: Promise<void> | undefined;
  const toolWait = createToolWaitWarmer(conversationId);
  return {
    wrap:
      (base = streamSimple) =>
      (model, context, options) => {
        if (!warmupsStopped && getChatConfig().cacheWarmingEnabled) {
          warmupsStopped = stopIdleWarmups(conversationId);
        }
        // The tools returned, so this request reads the cache.
        toolWait.stop();
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
      await warmupsStopped;
      if (!getChatConfig().cacheWarmingEnabled || !request) {
        return;
      }
      try {
        await toolWait.record(request, message);
      } catch (error) {
        logWarn("cache_warming.tool_wait.record_failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return;
      }
      lastCall = { request, message };
      if (idleEnded && message.stopReason !== "stop") {
        return;
      }
      idleEnded = message.stopReason !== "stop";
      try {
        await recordModelCall(
          conversationId,
          userActor,
          systemPrompt,
          request,
          message,
          message.stopReason === "stop" ? "reply" : undefined,
        );
      } catch (error) {
        logWarn("cache_warming.model_call.record_failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
      }
    },
    toolsReturned: toolWait.toolsReturned,
    noReplyEnded: () => {
      noReplyEnded = true;
    },
    stop: async () => {
      try {
        await toolWait.end();
      } catch (error) {
        logWarn("cache_warming.tool_wait.record_failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
      }
      // The `noReply` call stopped the run, so no final response came. Its
      // request holds the prefix that the next Turn reads.
      if (!noReplyEnded || !lastCall) return;
      try {
        await recordModelCall(
          conversationId,
          userActor,
          systemPrompt,
          lastCall.request,
          lastCall.message,
          "no_reply",
        );
      } catch (error) {
        logWarn("cache_warming.model_call.record_failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

/**
 * Run one scheduled cache warming message. A message for an idle period that
 * already ended does nothing and makes no span.
 *
 * Each warmup decision has one `cache_warming.warmup` span, with the warmup
 * call as a child `gen_ai.chat` span (`junior.cache_warmup`). A tool wait
 * warmup (`tool-wait.ts`) has the same span in the trace of its Turn.
 * `app.cache_warming.outcome`:
 * - `missed`: the warmup call did not read the cached prefix. It logs
 *   `cache_warming.warmup.failed` and reports to Sentry.
 * - `failed`: the warmup call threw.
 * - `skipped`: `skip_reason` is `cache_expired`, `breaker_open`,
 *   `prompt_changed` (a deploy changed the system prompt, so the idle period
 *   stops), `stopped` (warming stopped or the tools returned first; no log),
 *   `image_missing` (an image key of the snapshot expired, so the idle period
 *   stops), or a `decideWarmup` reason.
 *
 * Idle warmups carry the sizes of the idle period's snapshot:
 * `snapshot_bytes` (compressed, without images), `snapshot_image_count`
 * (distinct images stored under hash keys), and `snapshot_image_bytes`
 * (their base64 data). A snapshot that is still over the limit stores
 * nothing and warns `cache_warming.snapshot.skipped` with `skip_reason`
 * `snapshot_too_large`, `prefix_tokens`, and the same sizes. Each snapshot
 * also records the unsampled distribution metrics
 * `cache_warming.snapshot.bytes` and `cache_warming.snapshot.image_bytes`,
 * with `app.cache_warming.stored` false for a snapshot over the limit.
 *
 * `work_state` and `archived` are read when the idle period starts and pick
 * its `gapSegment`. `turn_ending` is `reply` or `no_reply`: how the Turn
 * before the idle period ended. The `conversation.returned` log has the same
 * three. Decision attributes are absent when the warmup skipped before the
 * decision. Cost and usage are absent when no call completed.
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
    await recordGap(state, conversationId, generation, warm, NO_REPLY_GAP_MS);
    return;
  }
  const warmups =
    (await state.get<number>(warmupsKey(conversationId, generation))) ?? 0;
  if (warmups !== message.cycle - 1) {
    return;
  }

  const attributes: Record<string, unknown> = {
    "app.cache_warming.cycle": message.cycle,
    "app.cache_warming.prefix_tokens": warm.prefixTokens,
    "app.cache_warming.trigger": "idle",
    ...segmentAttributes(warm),
    ...(warm.snapshot ? snapshotAttributes(warm.snapshot) : undefined),
    // Queue delay shows as a smaller time left than the warmup margin.
    "app.cache_warming.cache_ttl_left_ms":
      message.cacheExpiresAtMs - Date.now(),
  };
  await withSpan(
    "cache_warming.warmup",
    "cache_warming.warmup",
    { conversationId, modelId: warm.modelId },
    async (setSpanAttributes) => {
      const setOutcome = (
        outcome: string,
        extra: Record<string, unknown> = {},
      ) =>
        setSpanAttributes({
          ...attributes,
          ...extra,
          "app.cache_warming.outcome": outcome,
        });
      const skip = async (reason: string) => {
        const skipReason = { "app.cache_warming.skip_reason": reason };
        logInfo("cache_warming.warmup.skipped", {
          ...attributes,
          ...skipReason,
        });
        setOutcome("skipped", skipReason);
        await stop();
      };
      // The queue can deliver a warmup late, or a long Turn can leave no time
      // before the cache expires. The cache is gone, so this is not a miss.
      if (warmupTooLate(message.cacheExpiresAtMs)) {
        await skip("cache_expired");
        return;
      }
      if (await breakerOpen(state, warm.modelId)) {
        await skip("breaker_open");
        return;
      }
      // A deploy can change the system prompt. The next Turn then writes a
      // new prefix, so warming the old one buys nothing. Tool definitions can
      // change too, but the tool set differs per Conversation, so this does
      // not check them. Tool wait warming needs no check: it runs in the
      // process of the run, which sends the next request with this prompt.
      if (
        warm.systemPrompt &&
        warm.systemPrompt.hash !==
          systemPromptHash(
            await buildDeploymentSystemPrompt(
              warm.systemPrompt.platform,
              warm.systemPrompt.mode,
            ),
          )
      ) {
        await skip("prompt_changed");
        return;
      }

      const model = resolveGatewayModel(warm.modelId);
      const globalGapsMs = await state.getList<number>(
        segmentGapsKey(warm.segment),
      );
      const decision = decideWarmup({
        conversationGapsMs: await state.getList<number>(
          conversationGapsKey(conversationId, warm.segment),
        ),
        globalGapsMs,
        // Only a thin segment reads its parent's list.
        ...(warm.parentSegment && segmentNeedsParent(globalGapsMs.length)
          ? {
              parentGapsMs: await state.getList<number>(
                segmentGapsKey(warm.parentSegment),
              ),
            }
          : undefined),
        idleMs: Date.now() - idle.sinceMs,
        cacheExpiryIdleMs: message.cacheExpiresAtMs - idle.sinceMs,
        cacheTtlMs: warm.cacheTtlMs,
        prefixTokens: warm.prefixTokens,
        cacheReadPrice: model.cost.cacheRead,
        cacheWritePrice: model.cost.cacheWrite,
      });
      attributes["app.cache_warming.return_probability"] =
        decision.returnProbability;
      attributes["app.cache_warming.returns_per_warmup"] =
        decision.returnsPerWarmup;
      attributes["app.cache_warming.threshold"] = decision.threshold;
      attributes["app.cache_warming.parent_prior"] = decision.parentPrior;
      if (!decision.warm) {
        await skip(decision.reason);
        return;
      }

      const context = await loadSnapshot(
        state,
        conversationId,
        snapshotKey(conversationId, generation),
      );
      // Warming stopped, or the idle period ended.
      if (context === "stopped") {
        setOutcome("skipped", { "app.cache_warming.skip_reason": "stopped" });
        return;
      }
      if (context === "image_missing") {
        await skip("image_missing");
        return;
      }
      const startedAtMs = Date.now();
      const warmup = await sendWarmup(state, {
        conversationId,
        modelId: warm.modelId,
        context,
        ...(warm.reasoning ? { reasoning: warm.reasoning } : undefined),
        prefixTokens: warm.prefixTokens,
      }).catch(async (error: unknown) => {
        setOutcome("failed");
        await stop();
        throw error;
      });
      Object.assign(attributes, warmup.attributes);
      if (!warmup.refreshed) {
        // Stop this idle period. The miss already counts for the breaker.
        logWarn("cache_warming.warmup.failed", attributes);
        setOutcome("missed");
        await stop();
        return;
      }
      logInfo("cache_warming.warmup.completed", attributes);
      setOutcome("completed");

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
    attributes,
  );
}
