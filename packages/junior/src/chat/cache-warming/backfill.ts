/**
 * One-time fill of the cache warming gap lists from stored Conversation
 * history.
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
 */
import { performance } from "node:perf_hooks";
import { conversationKindFromRow } from "@/chat/conversations/sql/conversation-row";
import type { ConversationKind } from "@/chat/conversations/store";
import { getChatConfig } from "@/chat/config";
import { getSqlExecutor } from "@/chat/db";
import { logInfo, withSpan } from "@/chat/logging";
import { getStateAdapter } from "@/chat/state/adapter";
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

const BACKFILL_KEY = "junior:cache_warming:backfill";
// A run that fails or is stopped before it marks the install as done holds
// the claim for this long. Then a later heartbeat tries again.
const BACKFILL_CLAIM_TTL_MS = 60 * MINUTE_MS;
// Each batch is one query, and the SQL statement timeout applies to it. Small
// batches keep each query short and let the budget check run often.
const CONVERSATION_BATCH_SIZE = 10;
// Postgres `query_canceled`: the statement timeout stopped the query.
const QUERY_CANCELED = "57014";
// The heartbeat gives no deadline. This leaves most of its function time for
// the gap writes and the other heartbeat work.
const BACKFILL_BUDGET_MS = 60_000;
// State lists have no atomic replace, so live recording can append to a
// segment list while the backfill writes it. Each append over
// `GLOBAL_GAPS_MAX` drops the oldest entry. The backfill writes at most half
// the list, so live gaps are dropped only if more than half a list of them
// arrives during the write. The model reads the list as a histogram, so mixed
// order does not matter.
const BACKFILL_GAPS_MAX = GLOBAL_GAPS_MAX / 2;
// Each segment that `gapSegment` can return. It puts 3 or more ended Turns
// in one group.
const ALL_SEGMENTS = new Set(
  [true, false].flatMap((userActor) =>
    [0, 1, 2, 3].map((endedTurns) => gapSegment(userActor, endedTurns)),
  ),
);

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
  cacheRead: string | null;
  cacheWrite: string | null;
}

interface IdlePeriod {
  sinceMs: number;
  segment: string;
  eligible: boolean;
}

interface RecordedGap {
  segment: string;
  sinceMs: number;
  gapMs: number;
}

// Each Conversation that had activity in the window, newest first, so a run
// that stops on its budget has the most recent gaps. A Conversation that
// started earlier still needs its earlier Turns to get its Turn count.
async function loadConversations(
  windowStartMs: number,
): Promise<ConversationRow[]> {
  return await getSqlExecutor().query<ConversationRow>(
    `SELECT conversation_id AS "conversationId", kind,
       parent_conversation_id AS "parentConversationId"
     FROM junior_conversations
     WHERE last_activity_at >= $1 AND transcript_purged_at IS NULL
     ORDER BY last_activity_at DESC, conversation_id`,
    [new Date(windowStartMs).toISOString()],
  );
}

// Agent history stores each model response as an `assistant_message` and
// each instruction of a Turn as a `user_message`. Schema version 2 keeps the
// message fields in a JSON string, version 1 keeps them in the payload.
// A fork copies the rows of its source with their old times, so rows from
// before the Conversation was created are skipped.
async function loadEvents(conversationIds: string[]): Promise<EventRow[]> {
  return await getSqlExecutor().query<EventRow>(
    `SELECT e.conversation_id AS "conversationId", e.type,
       CASE WHEN e.type = 'user_message' THEN
         (e.payload->'provenance'->'actor'->>'userId') IS NOT NULL
       END AS "personInstruction",
       m.message->>'stopReason' AS "stopReason",
       m.message->>'timestamp' AS "startedAtMs",
       e.payload->'usage'->>'cacheRead' AS "cacheRead",
       e.payload->'usage'->>'cacheWrite' AS "cacheWrite"
     FROM junior_conversation_events e
     JOIN junior_conversations c ON c.conversation_id = e.conversation_id
     CROSS JOIN LATERAL (
       SELECT CASE
         WHEN e.type <> 'assistant_message' THEN NULL
         WHEN e.schema_version >= 2 THEN (e.payload->>'message')::jsonb
         ELSE e.payload
       END AS message
     ) m
     WHERE e.conversation_id = ANY($1::text[])
       AND (
         e.type = 'assistant_message'
         OR (
           e.type = 'user_message'
           AND (e.payload->'provenance'->>'authority') = 'instruction'
         )
       )
       AND e.created_at >= c.created_at
     ORDER BY e.conversation_id, e.seq`,
    [conversationIds],
  );
}

/**
 * Replay the model calls of one Conversation the way the recorder in
 * `warmup.ts` sees them, and return the gap of each idle period.
 *
 * Live recording measures from the start of the request that ended a Turn to
 * the start of the next recorded request. Here both times are the
 * `timestamp` of the stored assistant message, which Pi sets when it starts
 * the request. That is the closest stored time to the recorder's clock.
 *
 * Live recording records gaps only for idle periods that it could warm. The
 * stored usage gives the prefix size, so periods with a prefix below
 * `MIN_WARMUP_PREFIX_TOKENS` are skipped. The model, cache retention, and
 * snapshot size of the request are not checked: this assumes that reply
 * timing does not depend on them.
 */
function replayConversation(
  kind: ConversationKind,
  events: EventRow[],
  nowMs: number,
): RecordedGap[] {
  const gaps: RecordedGap[] = [];
  const close = (idle: IdlePeriod, untilMs: number) => {
    const gapMs = untilMs - idle.sinceMs;
    if (!idle.eligible || gapMs <= 0) return;
    gaps.push({
      segment: idle.segment,
      sinceMs: idle.sinceMs,
      // The horizon message records no reply before a later reply can.
      gapMs: gapMs >= IDLE_HORIZON_MS ? NO_REPLY_GAP_MS : gapMs,
    });
  };
  let userActor = false;
  // Live recording takes the Actor when the Turn starts. A later instruction
  // in the same Turn is steering and does not change it.
  let inTurn = false;
  let endedTurns = 0;
  let lastCallMs: number | undefined;
  let idle: IdlePeriod | undefined;
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
    if (idle) close(idle, startedAtMs);
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
      const prefixTokens =
        Number(event.cacheRead ?? 0) + Number(event.cacheWrite ?? 0);
      idle = {
        sinceMs: startedAtMs,
        segment: gapSegment(userActor, endedTurns),
        eligible: prefixTokens >= MIN_WARMUP_PREFIX_TOKENS,
      };
      endedTurns += 1;
    }
  }
  // An idle period that is still in its horizon has no gap yet.
  if (idle && nowMs - idle.sinceMs >= IDLE_HORIZON_MS) close(idle, nowMs);
  return gaps;
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

// Stop before the next batch when the budget is used. The budget uses the
// monotonic clock, not `nowMs`.
async function collectGaps(
  nowMs: number,
  budgetMs: number,
): Promise<{
  bySegment: Map<string, number[]>;
  scanned: number;
  canceledBatches: number;
  budgetExceeded: boolean;
}> {
  const startedAt = performance.now();
  const windowStartMs = nowMs - GLOBAL_GAPS_TTL_MS;
  const conversations = await loadConversations(windowStartMs);
  const recorded: RecordedGap[] = [];
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
      const gaps = replayConversation(
        conversationKindFromRow(conversation),
        events.get(conversation.conversationId) ?? [],
        nowMs,
      );
      recorded.push(...gaps.filter((gap) => gap.sinceMs >= windowStartMs));
    }
    scanned += batch.length;
  }
  recorded.sort((a, b) => a.sinceMs - b.sinceMs);
  const bySegment = new Map<string, number[]>();
  for (const gap of recorded) {
    const list = bySegment.get(gap.segment) ?? [];
    list.push(gap.gapMs);
    bySegment.set(gap.segment, list);
  }
  return {
    bySegment,
    scanned,
    canceledBatches,
    budgetExceeded,
  };
}

/**
 * Fill each empty cache warming gap list once per install from the stored
 * Conversation history. The heartbeat calls it each minute. After one run
 * completes, a call makes one state request and returns.
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
      for (const segment of ALL_SEGMENTS) {
        const gaps = await state.getList(segmentGapsKey(segment));
        if (gaps.length === 0) emptySegments.add(segment);
      }
      const { bySegment, scanned, canceledBatches, budgetExceeded } =
        await collectGaps(args.nowMs, args.budgetMs ?? BACKFILL_BUDGET_MS);
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
      await state.set(BACKFILL_KEY, "done");
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
