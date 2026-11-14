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
import { REPORT_BLOCKED_TOOL_NAME } from "@/chat/agent-invocations/blocked-report";
import { getChatConfig } from "@/chat/config";
import { logInfo, logWarn, withSpan } from "@/chat/logging";
import { resolveGatewayModel } from "@/chat/pi/client";
import { NO_REPLY_TOOL_NAME } from "@/chat/no-reply";
import { metrics } from "@/chat/sentry";
import { REPLY_TOOL_NAME } from "@/chat/turn-answer";
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
  TIMER_START_DELAY_MS,
  timerFloorMaxDueIdleMs,
  waitingGapSegment,
  type GapSegmentInput,
  type WaitingOn,
  type WorkState,
} from "./model";
import { sendCacheWarmup, type CacheWarmupMessage } from "./queue";
import {
  breakerOpen,
  CACHE_RETENTION,
  cachedPrefixTokens,
  connectedState,
  KEY_PREFIX,
  providerCacheTtlMs,
  sendWarmup,
  cacheTtlMs,
  warmupTiming,
  warmupTooLate,
  type ConnectedState,
  type ModelRequest,
} from "./request";
import {
  idlePeriodSavings,
  recordIdlePeriodSavings,
  recordWarmupCost,
} from "./savings";
import { loadSnapshot, saveSnapshot, type SnapshotSize } from "./snapshot";
import { createToolWaitWarmer } from "./tool-wait";
import { earliestTimerDueIdleMs, readPendingWork } from "./waiting";
import { readSegmentState } from "./work-state";

/** Gaps kept in each segment list. */
export const GLOBAL_GAPS_MAX = 2_000;
/** A segment list expires this long after its last gap. */
export const GLOBAL_GAPS_TTL_MS = 30 * 24 * 60 * MINUTE_MS;
const CONVERSATION_GAPS_MAX = 50;
/** The Turn count of a Conversation resets after this long with no call. */
export const CONVERSATION_STATE_TTL_MS = 7 * 24 * 60 * MINUTE_MS;
/** How the Turn before an idle period ended. */
export type TurnEnding = "reply" | "no_reply" | "blocked";
/**
 * Answer tools that end the run without a final response. A child agent
 * answers its parent with `reply`. People often answer a Turn that posted
 * nothing or that ended blocked, so it warms like a reply.
 */
export const ANSWER_TOOL_ENDINGS: Partial<Record<string, TurnEnding>> = {
  [REPLY_TOOL_NAME]: "reply",
  [NO_REPLY_TOOL_NAME]: "no_reply",
  [REPORT_BLOCKED_TOOL_NAME]: "blocked",
};

/** Warming stops when the snapshot of the idle period is deleted. */
interface WarmState {
  /** The `gapSegment` that this period records its gap in. */
  segment: string;
  /** Unset in idle periods from before it was stored. */
  turnEnding?: TurnEnding;
  /** The `parentGapSegment` that a thin `segment` leans on. */
  parentSegment?: string;
  /**
   * A child agent or a Review item that the idle period also waits on. The
   * gap is also recorded in the segment's `waitingGapSegment` child, which
   * the decision reads first.
   */
  waitingOn?: WaitingOn;
  /** Idle time at which a timer is due, for the timer floor. */
  timerDueIdleMs?: number;
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
  /**
   * Cached prefix of a period with no warm state, for its savings. Unset in
   * idle periods from before it was stored.
   */
  prefixTokens?: number;
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
  ...(warm.waitingOn
    ? { "app.cache_warming.waiting_on": warm.waitingOn }
    : undefined),
  ...(warm.timerDueIdleMs !== undefined
    ? { "app.cache_warming.timer_due_ms": warm.timerDueIdleMs }
    : undefined),
});
// Segment whose gaps decide the warmups of an idle period. The Conversation's
// gaps use it too, so a child agent's return does not count as a person's.
const decisionSegment = (warm: WarmState) =>
  warm.waitingOn
    ? waitingGapSegment(warm.segment, warm.waitingOn)
    : warm.segment;
// Segments that record the gap of an idle period, most specific first. The
// segment keeps every gap, so its waiting children can lean on it.
const recordedSegments = (warm: WarmState) =>
  warm.waitingOn ? [decisionSegment(warm), warm.segment] : [warm.segment];
// Whether the timer floor still warms after the horizon.
const timerPending = (warm: WarmState, idleMs: number) =>
  warm.timerDueIdleMs !== undefined &&
  idleMs < warm.timerDueIdleMs + TIMER_START_DELAY_MS;
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
  for (const segment of recordedSegments(warm)) {
    await state.appendToList(segmentGapsKey(segment), gapMs, {
      maxLength: GLOBAL_GAPS_MAX,
      ttlMs: GLOBAL_GAPS_TTL_MS,
    });
  }
  await state.appendToList(
    conversationGapsKey(conversationId, decisionSegment(warm)),
    gapMs,
    {
      maxLength: CONVERSATION_GAPS_MAX,
      ttlMs: CONVERSATION_STATE_TTL_MS,
    },
  );
}

// Start the idle period of a Turn that ended. Return none for an ending that
// starts no idle period.
async function startIdlePeriod(
  state: ConnectedState,
  conversationId: string,
  request: ModelRequest,
  message: AssistantMessage,
  turn: Pick<GapSegmentInput, "userActor" | "endedTurns">,
  systemPrompt: SystemPromptKey,
  turnEnding: TurnEnding,
): Promise<IdlePeriod | undefined> {
  const automation = systemPrompt.mode === "automation";
  // Read once here, not on each model call.
  const { watches, waitingOn } = await readPendingWork(
    conversationId,
    request.context.messages,
    message,
    automation,
  );
  // An Automation run almost never gets an answer. Its ending starts an idle
  // period only while a child agent or a Watch can start its next Turn.
  if (automation && !waitingOn) return undefined;
  const idle: IdlePeriod = {
    generation: randomUUID(),
    sinceMs: request.startedAtMs,
  };
  const prefixTokens = cachedPrefixTokens(message);
  const ttlMs = cacheTtlMs(request);
  if (ttlMs === undefined || prefixTokens < MIN_WARMUP_PREFIX_TOKENS) {
    return { ...idle, prefixTokens };
  }
  const timerDueIdleMs = earliestTimerDueIdleMs(
    watches,
    idle.sinceMs,
    timerFloorMaxDueIdleMs({
      cacheReadPrice: request.model.cost.cacheRead,
      cacheWritePrice: request.model.cost.cacheWrite,
      cacheTtlMs: ttlMs,
    }),
  );
  const { skipReason, ...snapshot } = await saveSnapshot(
    state,
    conversationId,
    snapshotKey(conversationId, idle.generation),
    request.context,
    // The timer floor can warm after the horizon, until the timer's Turn.
    Math.max(
      IDLE_HORIZON_MS,
      (timerDueIdleMs ?? 0) + TIMER_START_DELAY_MS + idle.sinceMs - Date.now(),
    ),
  );
  // Spans are sampled. These metrics show the size distribution of every
  // snapshot, so the limit can be tuned.
  const metricOptions = {
    unit: "byte",
    attributes: { "app.cache_warming.stored": skipReason === undefined },
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
  if (skipReason) {
    // A warning, so production keeps this idle period that Junior cannot warm.
    logWarn("cache_warming.snapshot.skipped", {
      "app.cache_warming.skip_reason": skipReason,
      "app.cache_warming.prefix_tokens": prefixTokens,
      ...snapshotAttributes(snapshot),
    });
    return { ...idle, prefixTokens };
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
      ...(waitingOn ? { waitingOn } : undefined),
      ...(timerDueIdleMs !== undefined ? { timerDueIdleMs } : undefined),
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

// Count the savings of the idle period that this call ends. A period with no
// warm state counts too, so the oracle shows the gaps that were never warmed.
async function recordSavings(
  idle: IdlePeriod,
  request: ModelRequest,
  message: AssistantMessage,
): Promise<void> {
  const prefixTokens = idle.warm?.prefixTokens ?? idle.prefixTokens;
  const ttlMs = idle.warm?.cacheTtlMs ?? providerCacheTtlMs(request.model.id);
  if (prefixTokens === undefined || ttlMs === undefined) return;
  const savings = idlePeriodSavings({
    cacheTtlMs: ttlMs,
    gapMs: request.startedAtMs - idle.sinceMs,
    prefixTokens,
    cacheRead: message.usage.cacheRead,
    cacheWrite: message.usage.cacheWrite,
    cacheReadPrice: request.model.cost.cacheRead,
    cacheWritePrice: request.model.cost.cacheWrite,
  });
  if (!savings) return;
  await recordIdlePeriodSavings(
    idle.warm?.modelId ?? request.model.id,
    savings,
    idle.warm !== undefined,
  );
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
  if (idle) await recordSavings(idle, request, message);

  // Mid-turn calls arrive seconds apart. Only the call that ends a turn
  // starts an idle period.
  const endedTurns = previous?.endedTurns ?? 0;
  const nextIdle = turnEnding
    ? await startIdlePeriod(
        state,
        conversationId,
        request,
        message,
        { userActor, endedTurns },
        systemPrompt,
        turnEnding,
      )
    : undefined;
  const next: ConversationCacheState = nextIdle
    ? { endedTurns: endedTurns + 1, idle: nextIdle }
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
   * Mark that an answer tool call of the last request ended the run. After
   * `reply`, `noReply` or `reportBlocked`, `stop` starts the idle period from
   * that request, as a final response would.
   */
  answerToolEnded(toolName: string): void;
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
  // The last finished call, for an idle period that an answer tool starts.
  let lastCall:
    | { request: ModelRequest; message: AssistantMessage }
    | undefined;
  let answerToolEnding: TurnEnding | undefined;
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
    answerToolEnded: (toolName) => {
      answerToolEnding = ANSWER_TOOL_ENDINGS[toolName];
    },
    stop: async () => {
      try {
        await toolWait.end(answerToolEnding !== undefined);
      } catch (error) {
        logWarn("cache_warming.tool_wait.record_failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
      }
      // The answer tool call stopped the run, so no final response came. Its
      // request holds the prefix that the next Turn reads.
      if (!answerToolEnding || !lastCall) return;
      try {
        await recordModelCall(
          conversationId,
          userActor,
          systemPrompt,
          lastCall.request,
          lastCall.message,
          answerToolEnding,
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
 * (their base64 data). A snapshot over a limit stores nothing and warns
 * `cache_warming.snapshot.skipped` with `prefix_tokens`, the same sizes, and
 * `skip_reason` `snapshot_too_large` (still over the limit without its
 * images) or `images_too_large` (its images are over their limit). Each
 * snapshot also records the unsampled distribution metrics
 * `cache_warming.snapshot.bytes` and `cache_warming.snapshot.image_bytes`,
 * with `app.cache_warming.stored` false for a snapshot over a limit.
 *
 * `work_state` and `archived` are read when the idle period starts and pick
 * its `gapSegment`. `turn_ending` is how the Turn before the idle period
 * ended: `reply` (a final response or `reply`), `no_reply` (`noReply`), or
 * `blocked` (`reportBlocked`). `waiting_on` is `child` (a child agent still
 * ran), `review` (the Turn asked a Review item), or `watch` (an Automation
 * run had an active Watch and no child agent) when the idle period starts,
 * and picks the segment's `waitingGapSegment` child. `timer_due_ms`
 * is the idle time at which a timer is due, when it is due within
 * `timerFloorMaxDueIdleMs`. The `conversation.returned` log has the same
 * five. Decision attributes are absent when the warmup skipped before the
 * decision. Of them, `timer_floor` is true for a warmup that only the timer
 * floor sends (`decideWarmup` reason `timer`). Cost and usage are absent
 * when no call completed.
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
    // The timer floor keeps warming until the timer's Turn.
    if (!timerPending(warm, Date.now() - idle.sinceMs)) {
      await stop();
    }
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
      // Most specific first: the waiting child, its segment, and the parent.
      const [segment, ...parents] = [
        ...recordedSegments(warm),
        ...(warm.parentSegment ? [warm.parentSegment] : []),
      ];
      const globalGapsMs = await state.getList<number>(
        segmentGapsKey(segment!),
      );
      // Only a thin list reads the list of its parent.
      const priorGapsMs: number[][] = [];
      for (const parent of parents) {
        if (!segmentNeedsParent((priorGapsMs.at(-1) ?? globalGapsMs).length)) {
          break;
        }
        priorGapsMs.push(await state.getList<number>(segmentGapsKey(parent)));
      }
      const decision = decideWarmup({
        conversationGapsMs: await state.getList<number>(
          conversationGapsKey(conversationId, decisionSegment(warm)),
        ),
        globalGapsMs,
        priorGapsMs,
        ...(warm.timerDueIdleMs !== undefined
          ? { timerDueIdleMs: warm.timerDueIdleMs }
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
      attributes["app.cache_warming.timer_floor"] = decision.reason === "timer";
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
      await recordWarmupCost(warm.modelId, warmup.costUsd);
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
