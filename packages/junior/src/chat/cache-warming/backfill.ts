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
 *
 * History does not tell the plugin work state or the archive state that a
 * Conversation had when an idle period started. So it fills only the
 * segments of Conversations that are not archived and have work state
 * `none`, which most Conversations have. The `open` and `done` segments and
 * the `archived:*` segments stay empty until live gaps arrive. With fewer
 * than `MIN_GAP_SAMPLES` gaps, `decideWarmup` returns `few_gaps` and Junior
 * sends no warmup. The idle period still records its gap, so the segment
 * fills from live idle periods.
 */
import { performance } from "node:perf_hooks";
import { conversationKindFromRow } from "@/chat/conversations/sql/conversation-row";
import type { ConversationKind } from "@/chat/conversations/store";
import { getChatConfig } from "@/chat/config";
import { getSqlExecutor } from "@/chat/db";
import { logInfo, withSpan } from "@/chat/logging";
import { getStateAdapter } from "@/chat/state/adapter";
import { MINUTE_MS } from "./model";
import {
  historySegment,
  loadReplayEvents,
  replayConversation,
  type ReplayEvent,
  type ReplayGap,
} from "./replay";
import { GLOBAL_GAPS_MAX, GLOBAL_GAPS_TTL_MS, segmentGapsKey } from "./warmup";

// The key names the segment format. A change of the `gapSegment` keys must
// change it, so that the fill runs again for the new segment lists.
const BACKFILL_KEY = "junior:cache_warming:backfill:work_state";
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
// Each segment that the backfill fills. `gapSegment` puts 3 or more ended
// Turns in one group.
const BACKFILL_SEGMENTS = new Set(
  [true, false].flatMap((userActor) =>
    [0, 1, 2, 3].map((endedTurns) => historySegment(userActor, endedTurns)),
  ),
);

interface ConversationRow {
  conversationId: string;
  kind: ConversationKind | null;
  parentConversationId: string | null;
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
  const recorded: ReplayGap[] = [];
  let scanned = 0;
  let canceledBatches = 0;
  let budgetExceeded = false;
  for (let i = 0; i < conversations.length; i += CONVERSATION_BATCH_SIZE) {
    if (i > 0 && performance.now() - startedAt >= budgetMs) {
      budgetExceeded = true;
      break;
    }
    const batch = conversations.slice(i, i + CONVERSATION_BATCH_SIZE);
    let rows: ReplayEvent[];
    try {
      rows = await loadReplayEvents(batch.map((row) => row.conversationId));
    } catch (error) {
      // A batch with too much history for one query is skipped. The budget
      // check still stops the scan in time.
      if (!isQueryCanceled(error)) throw error;
      canceledBatches += 1;
      continue;
    }
    const events = new Map<string, ReplayEvent[]>();
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
      for (const segment of BACKFILL_SEGMENTS) {
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
