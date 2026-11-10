/**
 * Replay the stored model calls of a Conversation with the rules of live gap
 * recording in `warmup.ts`. The backfill uses it to fill the gap lists, and
 * the People profile uses it to show the reply gaps of one person.
 */
import type { ConversationKind } from "@/chat/conversations/store";
import { getSqlExecutor } from "@/chat/db";
import {
  gapSegment,
  IDLE_HORIZON_MS,
  MIN_WARMUP_PREFIX_TOKENS,
  NO_REPLY_GAP_MS,
} from "./model";
import { CONVERSATION_STATE_TTL_MS } from "./warmup";

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
  eligible: boolean;
  /** Actor of the instruction that started the next Turn. */
  replyActor?: unknown;
}

/** Gap of one idle period that live recording would record. */
export interface ReplayGap {
  segment: string;
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
export async function loadReplayEvents(
  conversationIds: string[],
  sinceMs?: number,
): Promise<ReplayEvent[]> {
  return await getSqlExecutor().query<ReplayEvent>(
    `SELECT e.conversation_id AS "conversationId", e.type,
       CASE WHEN e.type = 'user_message' THEN
         (e.payload->'provenance'->'actor'->>'userId') IS NOT NULL
       END AS "personInstruction",
       CASE WHEN e.type = 'user_message' THEN
         e.payload->'provenance'->'actor'
       END AS "actor",
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
       AND ($2::timestamptz IS NULL OR e.created_at >= $2::timestamptz)
     ORDER BY e.conversation_id, e.seq`,
    [
      conversationIds,
      sinceMs === undefined ? null : new Date(sinceMs).toISOString(),
    ],
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
        eligible: prefixTokens >= MIN_WARMUP_PREFIX_TOKENS,
      };
      endedTurns += 1;
    }
  }
  // An idle period that is still in its horizon has no gap yet.
  if (idle && nowMs - idle.sinceMs >= IDLE_HORIZON_MS) close(idle, nowMs);
  return gaps;
}
