/**
 * Heartbeat backfill of the event search index for Conversations active in
 * the last week. A pass keeps its cursor in state, so each run resumes it. A
 * time budget and an event limit per half cap a run's database and embedding
 * spend. A pass that stores nothing marks the index done for a while. One claim
 * keeps runs apart. Runs and the task lock each Conversation, skip stored rows.
 */
import type { PluginEmbedder } from "@sentry/junior-plugin-api";
import { and, desc, eq, gt, gte, lt, notExists, or, sql } from "drizzle-orm";
import * as z from "zod";
import type { JuniorDatabase } from "@/db/db";
import { isPostgresErrorCode } from "@/db/postgres-error";
import {
  juniorConversationEventEmbeddings,
  juniorConversationEventLexemes,
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

const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
// Covers the whole run, the Conversation page reads included.
const BACKFILL_BUDGET_MS = 10_000;
// Each index query of a run reads one Conversation or one page of
// Conversations. A bad plan stops here instead of holding the database for
// minutes.
const SCAN_STATEMENT_TIMEOUT_MS = 5_000;
// The run deletes the claim when it ends. This TTL only frees the claim of a
// run that died first. It is longer than the budget plus one canceled query
// and one embedding batch, so a live run keeps it.
const BACKFILL_CLAIM_TTL_MS = 5 * 60 * 1_000;
// New events of a running Turn wait at most this long, unless the task of
// its completed Turn indexes them first.
const BACKFILL_DONE_TTL_MS = 10 * 60 * 1_000;
// A pass that no run continues for this long starts again from the newest
// Conversation.
const BACKFILL_PASS_TTL_MS = 24 * 60 * 60 * 1_000;
// A run of this size takes about 2 s on a local Postgres 17 for events of
// 5 KB each.
const MAX_LEXEME_EVENTS_PER_RUN = 1_000;
// Events embed at most 2,000 tokens each, so a run sends at most about
// 512,000 tokens.
const MAX_VECTOR_EVENTS_PER_RUN = 256;
const CONVERSATION_PAGE_SIZE = 50;
// Postgres `query_canceled`: the statement timeout stopped the query.
const QUERY_CANCELED = "57014";

const passCursorSchema = z.object({
  // Microsecond UTC time, so equal times compare equal in Postgres.
  at: z.string(),
  conversationId: z.string(),
});

const backfillPassSchema = z.object({
  after: passCursorSchema.nullable(),
  conversations: z.number(),
  events: z.number(),
  skipped: z.number(),
});

/** Progress of one pass over the recently active Conversations. */
export type EventSearchBackfillPass = z.infer<typeof backfillPassSchema>;

type PassCursor = z.infer<typeof passCursorSchema>;

const NEW_PASS: EventSearchBackfillPass = {
  after: null,
  conversations: 0,
  events: 0,
  skipped: 0,
};

/** Rows that indexing one Conversation stored, or why it was skipped. */
type ConversationIndexResult =
  | { kind: "indexed"; lexemes: number; vectors: number; more: boolean }
  | { kind: "skipped" };

// Run `run` in a transaction whose statements stop at the scan timeout.
async function withScanTimeout<T>(
  db: JuniorDatabase,
  run: (tx: JuniorDatabase) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${String(SCAN_STATEMENT_TIMEOUT_MS)}, true)`,
    );
    return await run(tx);
  });
}

// One page of the Conversations with activity since `sinceMs`, newest first,
// after `after`. It reads `junior_conversations_last_activity_idx`.
async function listActiveConversations(
  db: JuniorDatabase,
  args: { after: PassCursor | null; sinceMs: number },
): Promise<PassCursor[]> {
  const conversations = juniorConversations;
  const after = args.after;
  return await withScanTimeout(
    db,
    async (tx) =>
      await tx
        .select({
          at: sql<string>`to_char(${conversations.lastActivityAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          conversationId: conversations.conversationId,
        })
        .from(conversations)
        .where(
          and(
            gte(conversations.lastActivityAt, new Date(args.sinceMs)),
            after
              ? or(
                  lt(
                    conversations.lastActivityAt,
                    sql`${after.at}::timestamptz`,
                  ),
                  and(
                    eq(
                      conversations.lastActivityAt,
                      sql`${after.at}::timestamptz`,
                    ),
                    gt(conversations.conversationId, after.conversationId),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(
          desc(conversations.lastActivityAt),
          conversations.conversationId,
        )
        .limit(CONVERSATION_PAGE_SIZE),
  );
}

// Whether one Conversation has an event with lexemes and no vector of the
// embedder's model. An event without lexemes yet counts after a run stores
// them. Empty lexemes mean the event has no text to embed.
async function hasMissingVector(
  tx: JuniorDatabase,
  embedder: PluginEmbedder,
  conversationId: string,
): Promise<boolean> {
  const lexemes = juniorConversationEventLexemes;
  const vectors = juniorConversationEventEmbeddings;
  const rows = await tx
    .select({ seq: lexemes.seq })
    .from(lexemes)
    .where(
      and(
        eq(lexemes.conversationId, conversationId),
        sql`length(${lexemes.lexemes}) > 0`,
        notExists(
          tx
            .select({ seq: vectors.seq })
            .from(vectors)
            .where(
              and(
                eq(vectors.conversationId, lexemes.conversationId),
                eq(vectors.seq, lexemes.seq),
                eq(vectors.provider, embedder.provider),
                eq(vectors.model, embedder.model),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// Store the missing lexemes, then the missing vectors, of one Conversation
// within the room left in the run. `more` is set when rows may remain.
async function indexConversation(
  db: JuniorDatabase,
  args: {
    conversationId: string;
    deadlineMs: number;
    embedder?: PluginEmbedder;
    lexemeRoom: number;
    vectorRoom: number;
  },
): Promise<ConversationIndexResult> {
  const attempt = await withLock(
    getStateAdapter(),
    eventIndexLockKey(args.conversationId),
    async (): Promise<ConversationIndexResult> => {
      let lexemes: number;
      let vectorMissing: boolean;
      try {
        [lexemes, vectorMissing] = await withScanTimeout(db, async (tx) => {
          const stored = await storeConversationEventLexemes(
            tx,
            args.conversationId,
            args.lexemeRoom,
          );
          return [
            stored,
            args.embedder
              ? await hasMissingVector(tx, args.embedder, args.conversationId)
              : false,
          ] as const;
        });
      } catch (error) {
        // A Conversation with too much history for one query is skipped, so
        // the pass goes on.
        if (!isPostgresErrorCode(error, QUERY_CANCELED)) throw error;
        return { kind: "skipped" };
      }
      // The embedding call is not in the transaction, so it holds no
      // connection while it waits for the model.
      const vectors =
        args.embedder && vectorMissing
          ? await embedConversationEvents(
              db,
              args.embedder,
              args.conversationId,
              { deadlineMs: args.deadlineMs, maxEvents: args.vectorRoom },
            )
          : 0;
      return {
        kind: "indexed",
        lexemes,
        vectors,
        more:
          lexemes >= args.lexemeRoom ||
          (vectorMissing &&
            (vectors >= args.vectorRoom || Date.now() >= args.deadlineMs)),
      };
    },
    { ttlMs: EVENT_INDEX_LOCK_TTL_MS },
  );
  // The task indexes this Conversation now.
  return attempt.acquired ? attempt.value : { kind: "skipped" };
}

/**
 * Continue `pass` over the Conversations with activity in the last week:
 * store their missing lexemes, and missing vectors when `embedder` is set,
 * until the deadline or the event limits. Return what the run did and the
 * pass to continue next.
 */
export async function backfillEventSearchIndex(args: {
  db: JuniorDatabase;
  deadlineMs: number;
  embedder?: PluginEmbedder;
  nowMs: number;
  pass: EventSearchBackfillPass;
}) {
  const sinceMs = args.nowMs - ACTIVE_WINDOW_MS;
  const run = { conversations: 0, lexemes: 0, skipped: 0, vectors: 0 };
  let after = args.pass.after;
  const progress = (): EventSearchBackfillPass => ({
    after,
    conversations: args.pass.conversations + run.conversations,
    events: args.pass.events + run.lexemes + run.vectors,
    skipped: args.pass.skipped + run.skipped,
  });
  /* oxlint-disable no-await-in-loop -- Conversations run one at a time, so the run stops at its budget. */
  while (true) {
    if (Date.now() >= args.deadlineMs) {
      return { outcome: "limit_reached" as const, pass: progress(), run };
    }
    const page = await listActiveConversations(args.db, { after, sinceMs });
    for (const conversation of page) {
      const lexemeRoom = MAX_LEXEME_EVENTS_PER_RUN - run.lexemes;
      const vectorRoom = MAX_VECTOR_EVENTS_PER_RUN - run.vectors;
      if (
        Date.now() >= args.deadlineMs ||
        lexemeRoom <= 0 ||
        (args.embedder && vectorRoom <= 0)
      ) {
        return { outcome: "limit_reached" as const, pass: progress(), run };
      }
      const result = await indexConversation(args.db, {
        conversationId: conversation.conversationId,
        deadlineMs: args.deadlineMs,
        ...(args.embedder ? { embedder: args.embedder } : undefined),
        lexemeRoom,
        vectorRoom,
      });
      run.conversations += 1;
      if (result.kind === "skipped") {
        run.skipped += 1;
      } else {
        run.lexemes += result.lexemes;
        run.vectors += result.vectors;
        // The next run continues this Conversation.
        if (result.more) {
          return { outcome: "limit_reached" as const, pass: progress(), run };
        }
      }
      after = conversation;
    }
    if (page.length < CONVERSATION_PAGE_SIZE) {
      const pass = progress();
      return {
        outcome:
          pass.events === 0 && pass.skipped === 0
            ? ("completed" as const)
            : ("pass_ended" as const),
        pass,
        run,
      };
    }
  }
  /* oxlint-enable no-await-in-loop */
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
  const passKey = `${key}:pass`;
  const state = getStateAdapter();
  if (!(await state.setIfNotExists(key, "running", BACKFILL_CLAIM_TTL_MS))) {
    return;
  }
  // Earlier heartbeat phases use part of the heartbeat, so the budget starts
  // after the claim.
  const deadlineMs = Date.now() + BACKFILL_BUDGET_MS;
  let done = false;
  try {
    await withSpan(
      "event_search.backfill",
      "event_search.backfill",
      {},
      async (setSpanAttributes) => {
        const stored = backfillPassSchema.safeParse(await state.get(passKey));
        const result = await backfillEventSearchIndex({
          db: getDb(),
          deadlineMs,
          ...(args.embedder ? { embedder: args.embedder } : undefined),
          nowMs: args.nowMs,
          pass: stored.success ? stored.data : NEW_PASS,
        });
        if (result.outcome === "limit_reached") {
          await state.set(passKey, result.pass, BACKFILL_PASS_TTL_MS);
        } else {
          await state.delete(passKey);
        }
        if (result.outcome === "completed") {
          await state.set(key, "done", BACKFILL_DONE_TTL_MS);
          done = true;
        }
        setSpanAttributes({
          "app.event_search.backfill.conversation.count":
            result.run.conversations,
          "app.event_search.backfill.skipped.count": result.run.skipped,
          "app.event_search.backfill.lexeme.count": result.run.lexemes,
          "app.event_search.backfill.vector.count": result.run.vectors,
          "app.event_search.backfill.pass.conversation.count":
            result.pass.conversations,
          "app.event_search.backfill.pass.event.count": result.pass.events,
          "app.event_search.backfill.outcome": result.outcome,
        });
      },
    );
  } finally {
    // The next heartbeat continues the pass.
    if (!done) await state.delete(key);
  }
}
