/**
 * DIAGNOSTIC ONLY. Not for merge.
 *
 * Log where needle events rank in the product's fused event search, as the
 * agent's latest Turn sees it.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createConversationEmbedder } from "@/chat/conversations/embedding";
import { searchConversationEventText } from "@/chat/conversations/event-search";
import {
  callsToolSql,
  SEARCHABLE_EVENT_TYPES,
} from "@/chat/conversations/event-search-text";
import { searchedEventTextSql } from "@/chat/conversations/event-lexemes";
import { getDb } from "@/chat/db";
import { juniorConversationEvents } from "@/db/schema";

const LIMIT = 100;

/** Log fused ranks of `needle` events for each query. */
export async function logEventRanking(args: {
  conversationId: string;
  isNeedle: (text: string) => boolean;
  queries: readonly string[];
}): Promise<void> {
  const db = getDb();
  const events = juniorConversationEvents;
  const rows = await db
    .select({
      seq: events.seq,
      type: events.type,
      text: searchedEventTextSql(),
      callsTool: callsToolSql(),
    })
    .from(events)
    .where(
      and(
        eq(events.conversationId, args.conversationId),
        inArray(events.type, [...SEARCHABLE_EVENT_TYPES]),
      ),
    );
  const bySeq = new Map(rows.map((row) => [row.seq, row]));
  const [turn] = await db
    .select({
      seq: events.seq,
      turnId: sql<string>`${events.payload}->>'turnId'`,
    })
    .from(events)
    .where(
      and(
        eq(events.conversationId, args.conversationId),
        eq(events.type, "turn_started"),
      ),
    )
    .orderBy(desc(events.seq))
    .limit(1);
  const kind = (seq: number) => {
    const row = bySeq.get(seq);
    if (!row) return "unknown";
    const label = row.callsTool ? "tool_call" : row.type;
    return args.isNeedle(row.text ?? "") ? `${label} [NEEDLE]` : label;
  };
  const embedder = createConversationEmbedder({
    cost: { conversationId: args.conversationId },
    operation: "conversation_search_embedding",
  });
  const needles = rows
    .filter((row) => args.isNeedle(row.text ?? ""))
    .map((row) => row.seq);
  for (const query of args.queries) {
    for (const scope of ["before_turn", "whole_turn"] as const) {
      const seqs = (
        await searchConversationEventText(db, {
          conversationId: args.conversationId,
          embedder,
          limit: LIMIT,
          query,
          ...(turn ? { currentTurnId: turn.turnId } : undefined),
          ...(turn && scope === "before_turn"
            ? { beforeSeq: turn.seq }
            : undefined),
        })
      ).map((match) => match.event.seq);
      const rankOf = (seq: number) => {
        const index = seqs.indexOf(seq);
        return index < 0 ? null : index + 1;
      };
      console.log(
        `RANKDIAG ${JSON.stringify({
          query,
          scope,
          turnStartedSeq: turn?.seq ?? null,
          needles: needles.map((seq) => ({
            seq,
            kind: kind(seq),
            fusedRank: rankOf(seq),
          })),
          fusedTop10: seqs.slice(0, 10).map((seq) => ({
            seq,
            kind: kind(seq),
          })),
        })}`,
      );
    }
  }
}
