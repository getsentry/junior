/**
 * Replay the stored model calls of a Conversation with the rules of live gap
 * recording in `warmup.ts`. The backfill uses it to fill the gap lists, and
 * the People profile uses it to show the reply times of one person.
 */
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { ConversationKind } from "@/chat/conversations/store";
import { getDb } from "@/chat/db";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
import {
  gapSegment,
  IDLE_HORIZON_MS,
  MIN_WARMUP_PREFIX_TOKENS,
  NO_REPLY_GAP_MS,
  turnDepth,
  type TURN_DEPTHS,
} from "./model";
import { CONVERSATION_STATE_TTL_MS } from "./warmup";

// Each batch is one query, and the SQL statement timeout applies to it. Small
// batches keep each query short and let callers stop between batches.
const REPLAY_BATCH_SIZE = 10;
// Postgres `query_canceled`: the statement timeout stopped the query.
const QUERY_CANCELED = "57014";

/**
 * Segment of a stored idle period. History does not tell the plugin work
 * state or the archive state that the Conversation had then.
 */
export function historySegment(userActor: boolean, endedTurns: number): string {
  return gapSegment({
    userActor,
    endedTurns,
    workState: "none",
    archived: false,
  });
}

/** One stored model response or Turn instruction. */
export interface ReplayEvent {
  conversationId: string;
  type: "assistant_message" | "user_message";
  /** User message instruction: its Actor is a person. */
  personInstruction: boolean | null;
  /** User message instruction: the stored provenance Actor. */
  actor: unknown;
  stopReason: string | null;
  /** Assistant message: Pi sets it when the model request starts. */
  startedAtMs: string | null;
  cacheRead: string | null;
  cacheWrite: string | null;
}

interface IdlePeriod {
  sinceMs: number;
  segment: string;
  depth: (typeof TURN_DEPTHS)[number];
  eligible: boolean;
  /** Actor of the instruction that started the next Turn. */
  replyActor?: unknown;
}

/** Gap of one idle period that live recording would record. */
export interface ReplayGap {
  segment: string;
  /** Turn depth of the idle period, as in its segment. */
  depth: (typeof TURN_DEPTHS)[number];
  sinceMs: number;
  gapMs: number;
  /**
   * Stored Actor of the instruction that started the Turn that ended the
   * idle period. Undefined when no instruction started it.
   */
  replyActor?: unknown;
}

/**
 * Load the model responses and Turn instructions of these Conversations, in
 * order. `sinceMs` skips older rows.
 *
 * Agent history stores each model response as an `assistant_message` and
 * each instruction of a Turn as a `user_message`. Schema version 2 keeps the
 * message fields in a JSON string, version 1 keeps them in the payload. A
 * fork copies the rows of its source with their old times, so rows from
 * before the Conversation was created are skipped.
 */
async function loadReplayEvents(
  conversationIds: string[],
  sinceMs?: number,
): Promise<ReplayEvent[]> {
  const events = juniorConversationEvents;
  const isUserMessage = sql`${events.type} = 'user_message'`;
  const actor = sql`${events.payload}->'provenance'->'actor'`;
  const message = sql`CASE
    WHEN ${events.type} <> 'assistant_message' THEN NULL
    WHEN ${events.schemaVersion} >= 2 THEN (${events.payload}->>'message')::jsonb
    ELSE ${events.payload}
  END`;
  return await getDb()
    .select({
      conversationId: events.conversationId,
      type: sql<ReplayEvent["type"]>`${events.type}`,
      personInstruction: sql<
        boolean | null
      >`CASE WHEN ${isUserMessage} THEN (${actor}->>'userId') IS NOT NULL END`,
      actor: sql<unknown>`CASE WHEN ${isUserMessage} THEN ${actor} END`,
      stopReason: sql<string | null>`(${message})->>'stopReason'`,
      startedAtMs: sql<string | null>`(${message})->>'timestamp'`,
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
        sinceMs === undefined
          ? undefined
          : gte(events.createdAt, new Date(sinceMs)),
      ),
    )
    .orderBy(events.conversationId, events.seq);
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

/**
 * Load the replay events of these Conversations in small batches, by
 * Conversation. A Conversation can have too much history for one query, so a
 * batch that the statement timeout cancels is skipped and counted.
 * `shouldStop` runs before each batch after the first.
 */
export async function loadReplayEventBatches(
  conversationIds: string[],
  options: { shouldStop?: () => boolean; sinceMs?: number } = {},
): Promise<{
  canceledBatches: number;
  events: Map<string, ReplayEvent[]>;
  scanned: number;
  stopped: boolean;
}> {
  const events = new Map<string, ReplayEvent[]>();
  let canceledBatches = 0;
  let scanned = 0;
  for (let i = 0; i < conversationIds.length; i += REPLAY_BATCH_SIZE) {
    if (i > 0 && options.shouldStop?.()) {
      return { canceledBatches, events, scanned, stopped: true };
    }
    const batch = conversationIds.slice(i, i + REPLAY_BATCH_SIZE);
    let rows: ReplayEvent[];
    try {
      rows = await loadReplayEvents(batch, options.sinceMs);
    } catch (error) {
      if (!isQueryCanceled(error)) throw error;
      canceledBatches += 1;
      continue;
    }
    for (const row of rows) {
      const list = events.get(row.conversationId) ?? [];
      list.push(row);
      events.set(row.conversationId, list);
    }
    scanned += batch.length;
  }
  return { canceledBatches, events, scanned, stopped: false };
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
export function replayConversation(
  kind: ConversationKind,
  events: ReplayEvent[],
  nowMs: number,
): ReplayGap[] {
  const gaps: ReplayGap[] = [];
  const close = (idle: IdlePeriod, untilMs: number) => {
    const gapMs = untilMs - idle.sinceMs;
    if (!idle.eligible || gapMs <= 0) return;
    gaps.push({
      segment: idle.segment,
      depth: idle.depth,
      sinceMs: idle.sinceMs,
      // The horizon message records no reply before a later reply can.
      gapMs: gapMs >= IDLE_HORIZON_MS ? NO_REPLY_GAP_MS : gapMs,
      ...(idle.replyActor ? { replyActor: idle.replyActor } : undefined),
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
        if (idle) idle.replyActor = event.actor;
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
        segment: historySegment(userActor, endedTurns),
        depth: turnDepth(endedTurns),
        eligible: prefixTokens >= MIN_WARMUP_PREFIX_TOKENS,
      };
      endedTurns += 1;
    }
  }
  // An idle period that is still in its horizon has no gap yet.
  if (idle && nowMs - idle.sinceMs >= IDLE_HORIZON_MS) close(idle, nowMs);
  return gaps;
}
