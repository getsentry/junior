/**
 * Heartbeat backfill of the event search index. The event search task
 * indexes a bounded slice of events after each completed Turn, newest
 * first. History from before the index, the events of a running Turn, and
 * the rest of a long Conversation wait for later Turns. This run stores
 * their lexemes, and their vectors when event embeddings are on, in the
 * Conversations with activity in the last week, most recent first.
 *
 * Each run stops at a time budget and at an event count for each half, so
 * the embedding spend of a run has a ceiling. A run that leaves no backlog
 * marks the index done for a while, so later heartbeats make one state
 * request instead of a scan. Runs and the task skip stored rows and take
 * the lock of each Conversation, so they can overlap safely.
 *
 * Attributes on the `event_search.backfill` span:
 * - `app.event_search.backfill.backlog.conversation.count`: Conversations
 *   with events to index when the run started.
 * - `app.event_search.backfill.backlog.lexeme.count`,
 *   `app.event_search.backfill.backlog.vector.count`: events without
 *   lexemes, and without a vector of the model, when the run started.
 * - `app.event_search.backfill.lexeme.count`,
 *   `app.event_search.backfill.vector.count`: rows that the run stored.
 * - `app.event_search.backfill.outcome`: `completed` when the run indexed
 *   the whole backlog, else `limit_reached`.
 * Policy: policies/observability.md.
 */
import type { PluginEmbedder } from "@sentry/junior-plugin-api";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationEventEmbeddings,
  juniorConversationEventLexemes,
  juniorConversationEvents,
  juniorConversations,
} from "@/db/schema";
import { getDb } from "@/chat/db";
import { withSpan } from "@/chat/logging";
import { getStateAdapter } from "@/chat/state/adapter";
import { withLock } from "@/chat/state/locks";
import {
  embedConversationEvents,
  EVENT_INDEX_LOCK_TTL_MS,
  eventIndexLockKey,
} from "./event-embedding";
import { storeConversationEventLexemes } from "./event-lexemes";
import { SEARCHABLE_EVENT_TYPES } from "./event-search-text";

const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const BACKFILL_BUDGET_MS = 10_000;
const BACKFILL_CLAIM_TTL_MS = 60_000;
// New events of a running Turn wait at most this long, unless the task of
// its completed Turn indexes them first.
const BACKFILL_DONE_TTL_MS = 10 * 60 * 1_000;
// A run of this size takes about 2 s on a local Postgres 17 for events of
// 5 KB each.
const MAX_LEXEME_EVENTS_PER_RUN = 1_000;
// Events embed at most 2,000 tokens each, so a run sends at most about
// 512,000 tokens.
const MAX_VECTOR_EVENTS_PER_RUN = 256;
const MAX_BACKLOG_CONVERSATIONS = 200;

interface ConversationBacklog {
  conversationId: string;
  lexemes: number;
  vectors: number;
}

/**
 * Conversations with recent activity that have searchable events without
 * lexemes, or without a vector of the embedder's model, most recent first.
 */
async function listConversationBacklogs(
  db: JuniorDatabase,
  args: { embedder?: PluginEmbedder; sinceMs: number },
): Promise<ConversationBacklog[]> {
  const events = juniorConversationEvents;
  const lexemes = juniorConversationEventLexemes;
  const vectors = juniorConversationEventEmbeddings;
  const conversations = juniorConversations;
  const missingLexemes = sql<number>`count(*) filter (where ${lexemes.seq} is null)`;
  // An event without text gets no vector, so it is not a backlog. Its stored
  // lexemes are empty, which spares parsing every event on each run. An event
  // without stored lexemes counts until a run stores them.
  const missingVectors = args.embedder
    ? sql<number>`count(*) filter (where ${vectors.seq} is null and (${lexemes.seq} is null or length(${lexemes.lexemes}) > 0))`
    : sql<number>`0`;
  const query = db
    .select({
      conversationId: events.conversationId,
      lexemes: missingLexemes.mapWith(Number),
      vectors: missingVectors.mapWith(Number),
    })
    .from(events)
    .innerJoin(
      conversations,
      eq(conversations.conversationId, events.conversationId),
    )
    .leftJoin(
      lexemes,
      and(
        eq(lexemes.conversationId, events.conversationId),
        eq(lexemes.seq, events.seq),
      ),
    )
    .$dynamic();
  const embedder = args.embedder;
  const joined = embedder
    ? query.leftJoin(
        vectors,
        and(
          eq(vectors.conversationId, events.conversationId),
          eq(vectors.seq, events.seq),
          eq(vectors.provider, embedder.provider),
          eq(vectors.model, embedder.model),
        ),
      )
    : query;
  return await joined
    .where(
      and(
        gte(conversations.lastActivityAt, new Date(args.sinceMs)),
        inArray(events.type, [...SEARCHABLE_EVENT_TYPES]),
      ),
    )
    .groupBy(events.conversationId, conversations.lastActivityAt)
    .having(sql`${missingLexemes} > 0 or ${missingVectors} > 0`)
    .orderBy(desc(conversations.lastActivityAt), events.conversationId)
    .limit(MAX_BACKLOG_CONVERSATIONS);
}

/**
 * Store missing lexemes, and missing vectors when `embedder` is set, of the
 * Conversations with activity in the last week. Return what it stored and
 * whether it indexed the whole backlog.
 */
export async function backfillEventSearchIndex(args: {
  db: JuniorDatabase;
  deadlineMs: number;
  embedder?: PluginEmbedder;
  nowMs: number;
}) {
  const backlogs = await listConversationBacklogs(args.db, {
    ...(args.embedder ? { embedder: args.embedder } : undefined),
    sinceMs: args.nowMs - ACTIVE_WINDOW_MS,
  });
  const state = getStateAdapter();
  const stored = { lexemes: 0, vectors: 0 };
  let done = backlogs.length < MAX_BACKLOG_CONVERSATIONS;
  /* oxlint-disable no-await-in-loop -- Conversations run one at a time, so the run stops at its budget. */
  for (const backlog of backlogs) {
    const lexemeRoom = MAX_LEXEME_EVENTS_PER_RUN - stored.lexemes;
    const vectorRoom = args.embedder
      ? MAX_VECTOR_EVENTS_PER_RUN - stored.vectors
      : 0;
    if (
      Date.now() >= args.deadlineMs ||
      (backlog.lexemes > 0 && lexemeRoom <= 0) ||
      (backlog.vectors > 0 && vectorRoom <= 0)
    ) {
      done = false;
      break;
    }
    const attempt = await withLock(
      state,
      eventIndexLockKey(backlog.conversationId),
      async () => {
        const lexemes =
          backlog.lexemes > 0
            ? await storeConversationEventLexemes(
                args.db,
                backlog.conversationId,
                lexemeRoom,
              )
            : 0;
        const vectors =
          args.embedder && backlog.vectors > 0
            ? await embedConversationEvents(
                args.db,
                args.embedder,
                backlog.conversationId,
                { deadlineMs: args.deadlineMs, maxEvents: vectorRoom },
              )
            : 0;
        return { lexemes, vectors };
      },
      { ttlMs: EVENT_INDEX_LOCK_TTL_MS },
    );
    if (!attempt.acquired) {
      // The task indexes this Conversation now. A later run checks it again.
      done = false;
      continue;
    }
    stored.lexemes += attempt.value.lexemes;
    stored.vectors += attempt.value.vectors;
    if (
      attempt.value.lexemes < backlog.lexemes ||
      attempt.value.vectors < backlog.vectors
    ) {
      done = false;
    }
  }
  /* oxlint-enable no-await-in-loop */
  return {
    backlog: {
      conversations: backlogs.length,
      lexemes: backlogs.reduce((sum, backlog) => sum + backlog.lexemes, 0),
      vectors: backlogs.reduce((sum, backlog) => sum + backlog.vectors, 0),
    },
    done,
    stored,
  };
}

/**
 * Index the backlog of event search in recently active Conversations.
 * Vectors only when `embedder` is set.
 */
export async function runEventSearchBackfill(args: {
  embedder?: PluginEmbedder;
  nowMs: number;
}): Promise<void> {
  const key = `junior:event_search:backfill:${
    args.embedder
      ? `${args.embedder.provider}:${args.embedder.model}`
      : "lexemes"
  }`;
  const state = getStateAdapter();
  if (!(await state.setIfNotExists(key, "running", BACKFILL_CLAIM_TTL_MS))) {
    return;
  }
  await withSpan(
    "event_search.backfill",
    "event_search.backfill",
    {},
    async (setSpanAttributes) => {
      const result = await backfillEventSearchIndex({
        db: getDb(),
        // Earlier heartbeat phases use part of the heartbeat, so the budget
        // starts now.
        deadlineMs: Date.now() + BACKFILL_BUDGET_MS,
        ...(args.embedder ? { embedder: args.embedder } : undefined),
        nowMs: args.nowMs,
      });
      if (result.done) {
        await state.set(key, "done", BACKFILL_DONE_TTL_MS);
      }
      setSpanAttributes({
        "app.event_search.backfill.backlog.conversation.count":
          result.backlog.conversations,
        "app.event_search.backfill.backlog.lexeme.count":
          result.backlog.lexemes,
        "app.event_search.backfill.backlog.vector.count":
          result.backlog.vectors,
        "app.event_search.backfill.lexeme.count": result.stored.lexemes,
        "app.event_search.backfill.vector.count": result.stored.vectors,
        "app.event_search.backfill.outcome": result.done
          ? "completed"
          : "limit_reached",
      });
    },
  );
}
