/**
 * Fill of the empty cache warming gap lists from stored Conversation
 * history, about once a month.
 *
 * `warmup.ts` learns reply gaps only from idle periods after it is deployed.
 * Until a `gapSegment` has gaps, Junior sends no warmups for it. This replays
 * the stored model calls of the last `GLOBAL_GAPS_TTL_MS` with the same rules
 * as live recording, so warming can start soon after the first deploy.
 *
 * The heartbeat runs it. Only one run claims it, and a completed run marks
 * the install as done, also when it stopped on its time budget or skipped a
 * batch that the statement timeout canceled. It fills only segment lists
 * that are empty when it starts, so it does not add history to gaps that
 * live recording already has.
 *
 * History does not tell the plugin work state or the archive state that a
 * Conversation had when an idle period started. So it fills only the
 * segments of Conversations that are not archived and have work state
 * `none`, which most Conversations have. The `open` and `done` segments and
 * the `archived:*` segments stay empty until live gaps arrive. Until then,
 * `decideWarmup` leans on their `parentGapSegment`, a `none` segment that
 * this fills. Each idle period still records its gap, so the segment fills
 * from live idle periods.
 */
import { performance } from "node:perf_hooks";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { conversationKindFromRow } from "@/chat/conversations/sql/conversation-row";
import type { ConversationKind } from "@/chat/conversations/store";
import { getChatConfig } from "@/chat/config";
import { getDb } from "@/chat/db";
import { logInfo, withSpan } from "@/chat/logging";
import { getStateAdapter } from "@/chat/state/adapter";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
import {
  gapSegment,
  IDLE_HORIZON_MS,
  MIN_WARMUP_PREFIX_TOKENS,
  MINUTE_MS,
  NO_REPLY_GAP_MS,
} from "./model";
import {
  CONVERSATION_STATE_TTL_MS,
  GLOBAL_GAPS_MAX,
  GLOBAL_GAPS_TTL_MS,
  segmentGapsKey,
} from "./warmup";

// The key names the segment format. A change of the `gapSegment` keys must
// change it, so that the fill runs again for the new segment lists. `v2`
// replaces a key whose `done` had no TTL. Existing installs run the backfill
// once more after deploy, and that run fills only segments that are empty.
const BACKFILL_KEY = "junior:cache_warming:backfill:work_state:v2";
// A run that fails or is stopped before it marks the install as done holds
// the claim for this long. Then a later heartbeat tries again.
const BACKFILL_CLAIM_TTL_MS = 60 * MINUTE_MS;
// A completed run expires after the gap list TTL. Then a heartbeat checks
// for empty segment lists again, about once a month, for a fresh install and
// for one that has run for a long time. A list that expired while warming was
// off gets history again. Until then a heartbeat makes one state call.
const BACKFILL_DONE_TTL_MS = GLOBAL_GAPS_TTL_MS;
// Each batch is one query, and the SQL statement timeout applies to it. Small
// batches keep each query short and let the budget check run often.
const CONVERSATION_BATCH_SIZE = 10;
// Postgres `query_canceled`: the statement timeout stopped the query.
const QUERY_CANCELED = "57014";
/**
 * Scan time of one backfill run. The heartbeat gives no deadline. This leaves
 * most of its function time for the writes and the other heartbeat work.
 */
export const BACKFILL_BUDGET_MS = 60_000;
// State lists have no atomic replace, so live recording can append to a
// segment list while the backfill writes it. Each append over
// `GLOBAL_GAPS_MAX` drops the oldest entry. The backfill writes at most half
// the list, so live gaps are dropped only if more than half a list of them
// arrives during the write. The model reads the list as a histogram, so mixed
// order does not matter.
const BACKFILL_GAPS_MAX = GLOBAL_GAPS_MAX / 2;
// Each segment that the backfill fills. `gapSegment` puts 3 or more ended
// Turns in one group.
const BACKFILL_SEGMENTS = new Set(
  [true, false].flatMap((userActor) =>
    [0, 1, 2, 3].map((endedTurns) => historySegment(userActor, endedTurns)),
  ),
);

function historySegment(userActor: boolean, endedTurns: number): string {
  return gapSegment({
    userActor,
    endedTurns,
    workState: "none",
    archived: false,
  });
}

interface ConversationRow {
  conversationId: string;
  kind: ConversationKind | null;
  parentConversationId: string | null;
}

interface EventRow {
  conversationId: string;
  type: "assistant_message" | "user_message";
  /** User message instruction: its Actor is a person. */
  personInstruction: boolean | null;
  stopReason: string | null;
  /** Assistant message: Pi sets it when the model request starts. */
  startedAtMs: string | null;
  modelId: string | null;
  cacheRead: string | null;
  cacheWrite: string | null;
}

/** One idle period of the stored history, as live recording would see it. */
export interface ReplayedIdlePeriod {
  segment: string;
  sinceMs: number;
  /** Real time until the call that ended it, or until now. */
  gapMs: number;
  /** Read and write tokens of the call that started it. */
  prefixTokens: number;
  /** The call that ended it. Unset when no call came before now. */
  next?: { modelId: string | null; cacheRead: number; cacheWrite: number };
}

// Each Conversation that had activity in the window, newest first, so a run
// that stops on its budget has the most recent gaps. A Conversation that
// started earlier still needs its earlier Turns to get its Turn count.
async function loadConversations(
  windowStartMs: number,
): Promise<ConversationRow[]> {
  return await getDb()
    .select({
      conversationId: juniorConversations.conversationId,
      kind: juniorConversations.kind,
      parentConversationId: juniorConversations.parentConversationId,
    })
    .from(juniorConversations)
    .where(
      and(
        gte(juniorConversations.lastActivityAt, new Date(windowStartMs)),
        isNull(juniorConversations.transcriptPurgedAt),
      ),
    )
    .orderBy(
      desc(juniorConversations.lastActivityAt),
      juniorConversations.conversationId,
    );
}

// Agent history stores each model response as an `assistant_message` and
// each instruction of a Turn as a `user_message`. Schema version 2 keeps the
// message fields in a JSON string, version 1 keeps them in the payload.
// A fork copies the rows of its source with their old times, so rows from
// before the Conversation was created are skipped.
async function loadEvents(conversationIds: string[]): Promise<EventRow[]> {
  const events = juniorConversationEvents;
  const isUserMessage = sql`${events.type} = 'user_message'`;
  const message = sql`CASE
    WHEN ${events.type} <> 'assistant_message' THEN NULL
    WHEN ${events.schemaVersion} >= 2 THEN (${events.payload}->>'message')::jsonb
    ELSE ${events.payload}
  END`;
  return await getDb()
    .select({
      conversationId: events.conversationId,
      type: sql<EventRow["type"]>`${events.type}`,
      personInstruction: sql<
        boolean | null
      >`CASE WHEN ${isUserMessage} THEN (${events.payload}->'provenance'->'actor'->>'userId') IS NOT NULL END`,
      stopReason: sql<string | null>`(${message})->>'stopReason'`,
      startedAtMs: sql<string | null>`(${message})->>'timestamp'`,
      modelId: sql<string | null>`(${message})->>'model'`,
      cacheRead: sql<string | null>`${events.payload}->'usage'->>'cacheRead'`,
      cacheWrite: sql<string | null>`${events.payload}->'usage'->>'cacheWrite'`,
    })
    .from(events)
    .innerJoin(
      juniorConversations,
      eq(juniorConversations.conversationId, events.conversationId),
    )
    .where(
      and(
        inArray(events.conversationId, conversationIds),
        or(
          eq(events.type, "assistant_message"),
          and(
            isUserMessage,
            sql`(${events.payload}->'provenance'->>'authority') = 'instruction'`,
          ),
        ),
        gte(events.createdAt, juniorConversations.createdAt),
      ),
    )
    .orderBy(events.conversationId, events.seq);
}

/**
 * Replay the model calls of one Conversation the way the recorder in
 * `warmup.ts` sees them, and return each idle period.
 *
 * Live recording measures from the start of the request that ended a Turn to
 * the start of the next recorded request. Here both times are the
 * `timestamp` of the stored assistant message, which Pi sets when it starts
 * the request. That is the closest stored time to the recorder's clock.
 */
function replayConversation(
  kind: ConversationKind,
  events: EventRow[],
  nowMs: number,
): ReplayedIdlePeriod[] {
  const periods: ReplayedIdlePeriod[] = [];
  type Idle = Omit<ReplayedIdlePeriod, "gapMs" | "next">;
  const close = (
    idle: Idle,
    untilMs: number,
    next?: ReplayedIdlePeriod["next"],
  ) => {
    const gapMs = untilMs - idle.sinceMs;
    if (gapMs <= 0) return;
    const period: ReplayedIdlePeriod = { ...idle, gapMs };
    if (next) period.next = next;
    periods.push(period);
  };
  let userActor = false;
  // Live recording takes the Actor when the Turn starts. A later instruction
  // in the same Turn is steering and does not change it.
  let inTurn = false;
  let endedTurns = 0;
  let lastCallMs: number | undefined;
  let idle: Idle | undefined;
  for (const event of events) {
    if (event.type === "user_message") {
      if (!inTurn) {
        // `agent/index.ts` counts a Task as not started by a person.
        userActor = event.personInstruction === true && kind !== "task";
        inTurn = true;
      }
      continue;
    }
    // Pi continues the Turn only after a tool call.
    if (event.stopReason !== "toolUse") inTurn = false;
    // `Number(null)` is 0, so check for a missing time first.
    const startedAtMs =
      event.startedAtMs === null ? Number.NaN : Number(event.startedAtMs);
    // The recorder skips failed and stopped requests.
    if (
      !Number.isFinite(startedAtMs) ||
      event.stopReason === "error" ||
      event.stopReason === "aborted"
    ) {
      continue;
    }
    const cacheRead = Number(event.cacheRead ?? 0);
    const cacheWrite = Number(event.cacheWrite ?? 0);
    if (idle) {
      close(idle, startedAtMs, {
        modelId: event.modelId,
        cacheRead,
        cacheWrite,
      });
    }
    idle = undefined;
    // The Conversation state expired, so the recorder starts the Turn count
    // again.
    if (
      lastCallMs !== undefined &&
      startedAtMs - lastCallMs > CONVERSATION_STATE_TTL_MS
    ) {
      endedTurns = 0;
    }
    lastCallMs = startedAtMs;
    if (event.stopReason === "stop") {
      idle = {
        sinceMs: startedAtMs,
        segment: historySegment(userActor, endedTurns),
        prefixTokens: cacheRead + cacheWrite,
      };
      endedTurns += 1;
    }
  }
  // An idle period that is still in its horizon has no gap yet.
  if (idle && nowMs - idle.sinceMs >= IDLE_HORIZON_MS) close(idle, nowMs);
  return periods;
}

function isQueryCanceled(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (typeof current !== "object") return false;
    if ((current as { code?: unknown }).code === QUERY_CANCELED) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Idle periods of a history scan, and how much of the history it read. */
export interface HistoryScan {
  periods: ReplayedIdlePeriod[];
  scanned: number;
  canceledBatches: number;
  budgetExceeded: boolean;
}

/**
 * Replay the stored history of each Conversation with activity since
 * `windowStartMs`, newest first, and return its idle periods that started in
 * the window, oldest first. The scan stops before the next batch when the
 * budget is used. The budget uses the monotonic clock, not `nowMs`.
 */
export async function scanIdlePeriods(args: {
  windowStartMs: number;
  nowMs: number;
  budgetMs: number;
}): Promise<HistoryScan> {
  const { windowStartMs, nowMs, budgetMs } = args;
  const startedAt = performance.now();
  const conversations = await loadConversations(windowStartMs);
  const periods: ReplayedIdlePeriod[] = [];
  let scanned = 0;
  let canceledBatches = 0;
  let budgetExceeded = false;
  for (let i = 0; i < conversations.length; i += CONVERSATION_BATCH_SIZE) {
    if (i > 0 && performance.now() - startedAt >= budgetMs) {
      budgetExceeded = true;
      break;
    }
    const batch = conversations.slice(i, i + CONVERSATION_BATCH_SIZE);
    let rows: EventRow[];
    try {
      rows = await loadEvents(batch.map((row) => row.conversationId));
    } catch (error) {
      // A batch with too much history for one query is skipped. The budget
      // check still stops the scan in time.
      if (!isQueryCanceled(error)) throw error;
      canceledBatches += 1;
      continue;
    }
    const events = new Map<string, EventRow[]>();
    for (const event of rows) {
      const list = events.get(event.conversationId) ?? [];
      list.push(event);
      events.set(event.conversationId, list);
    }
    for (const conversation of batch) {
      const replayed = replayConversation(
        conversationKindFromRow(conversation),
        events.get(conversation.conversationId) ?? [],
        nowMs,
      );
      periods.push(
        ...replayed.filter((period) => period.sinceMs >= windowStartMs),
      );
    }
    scanned += batch.length;
  }
  periods.sort((a, b) => a.sinceMs - b.sinceMs);
  return { periods, scanned, canceledBatches, budgetExceeded };
}

// Live recording records gaps only for idle periods that it could warm. The
// stored usage gives the prefix size, so periods with a prefix below
// `MIN_WARMUP_PREFIX_TOKENS` are skipped. The model, cache retention, and
// snapshot size of the request are not checked: this assumes that reply
// timing does not depend on them.
function gapsBySegment(
  periods: readonly ReplayedIdlePeriod[],
): Map<string, number[]> {
  const bySegment = new Map<string, number[]>();
  for (const period of periods) {
    if (period.prefixTokens < MIN_WARMUP_PREFIX_TOKENS) continue;
    const list = bySegment.get(period.segment) ?? [];
    // The horizon message records no reply before a later reply can.
    list.push(period.gapMs >= IDLE_HORIZON_MS ? NO_REPLY_GAP_MS : period.gapMs);
    bySegment.set(period.segment, list);
  }
  return bySegment;
}

/**
 * Fill each empty cache warming gap list from the stored Conversation
 * history. The heartbeat calls it each minute. After a run completes, a call
 * makes one state request and returns, until the completed run expires.
 *
 * A run that uses its scan budget writes the gaps that it has and also
 * completes. Some gaps are better than none, and a run that cannot finish
 * would otherwise try again each hour.
 */
export async function backfillCacheWarmingGaps(args: {
  nowMs: number;
  budgetMs?: number;
}): Promise<void> {
  if (!getChatConfig().cacheWarmingEnabled) return;
  const state = getStateAdapter();
  await state.connect();
  if (
    !(await state.setIfNotExists(
      BACKFILL_KEY,
      "running",
      BACKFILL_CLAIM_TTL_MS,
    ))
  ) {
    return;
  }
  await withSpan(
    "cache_warming.backfill",
    "cache_warming.backfill",
    {},
    async (setSpanAttributes) => {
      // Check before the scan, so live gaps that arrive during the scan do
      // not stop the fill. A list that has gaps now has live gaps, or gaps
      // from a run that failed while it wrote. Both are kept as they are.
      const emptySegments = new Set<string>();
      for (const segment of BACKFILL_SEGMENTS) {
        const gaps = await state.getList(segmentGapsKey(segment));
        if (gaps.length === 0) emptySegments.add(segment);
      }
      const { periods, scanned, canceledBatches, budgetExceeded } =
        await scanIdlePeriods({
          windowStartMs: args.nowMs - GLOBAL_GAPS_TTL_MS,
          nowMs: args.nowMs,
          budgetMs: args.budgetMs ?? BACKFILL_BUDGET_MS,
        });
      const bySegment = gapsBySegment(periods);
      const logAttributes = {
        "app.cache_warming.backfill.conversation_count": scanned,
        "app.cache_warming.backfill.canceled_batch_count": canceledBatches,
        "app.cache_warming.backfill.budget_exceeded": budgetExceeded,
      };
      // Only canceled queries: no history was read. The claim expires, and a
      // later heartbeat tries again.
      if (scanned === 0 && canceledBatches > 0) {
        logInfo("cache_warming.backfill.not_completed", logAttributes);
        setSpanAttributes({
          ...logAttributes,
          "app.cache_warming.backfill.outcome": "not_completed",
        });
        return;
      }
      let gapCount = 0;
      let segmentCount = 0;
      for (const [segment, gaps] of bySegment) {
        if (!emptySegments.has(segment)) continue;
        const key = segmentGapsKey(segment);
        const newest = gaps.slice(-BACKFILL_GAPS_MAX);
        for (const gapMs of newest) {
          await state.appendToList(key, gapMs, {
            maxLength: GLOBAL_GAPS_MAX,
            ttlMs: GLOBAL_GAPS_TTL_MS,
          });
        }
        gapCount += newest.length;
        segmentCount += 1;
      }
      await state.set(BACKFILL_KEY, "done", BACKFILL_DONE_TTL_MS);
      const completed = {
        ...logAttributes,
        "app.cache_warming.backfill.gap_count": gapCount,
        "app.cache_warming.backfill.segment_count": segmentCount,
      };
      logInfo("cache_warming.backfill.completed", completed);
      setSpanAttributes({
        ...completed,
        "app.cache_warming.backfill.outcome": "completed",
      });
    },
  );
}
