/**
 * DIAGNOSTIC ONLY. Not for merge.
 *
 * Log where the mail host's tool result ranks in the keyword list, the
 * meaning list, and the fused list of one Conversation's event search.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { guardedCosineDistance } from "@sentry/junior-plugin-api/embeddings";
import {
  createConversationEmbedder,
  embedConversationQuery,
} from "@/chat/conversations/embedding";
import {
  fuseEventRanks,
  searchConversationEventText,
} from "@/chat/conversations/event-search";
import { searchedEventTextSql } from "@/chat/conversations/event-lexemes";
import { SEARCHABLE_EVENT_TYPES } from "@/chat/conversations/event-search-text";
import { getDb } from "@/chat/db";
import {
  juniorConversationEventEmbeddings,
  juniorConversationEvents,
} from "@/db/schema";

const LEG = 100;
const RRF_K = 60;

interface Row {
  distance?: number;
  kind: string;
  rank: number;
  rrf?: number;
  seq: number;
  text: string;
}

/** Log keyword, meaning, and fused ranks of `needle` events for each query. */
export async function logEventRanking(args: {
  conversationId: string;
  isNeedle: (text: string) => boolean;
  queries: readonly string[];
}): Promise<void> {
  const db = getDb();
  const events = juniorConversationEvents;
  const embeddings = juniorConversationEventEmbeddings;
  const rows = await db
    .select({
      seq: events.seq,
      type: events.type,
      text: searchedEventTextSql(),
    })
    .from(events)
    .where(
      and(
        eq(events.conversationId, args.conversationId),
        inArray(events.type, [...SEARCHABLE_EVENT_TYPES]),
      ),
    )
    .orderBy(asc(events.seq));
  const bySeq = new Map(rows.map((row) => [row.seq, row]));
  const embedded = await db
    .select({ seq: embeddings.seq })
    .from(embeddings)
    .where(eq(embeddings.conversationId, args.conversationId));
  const embeddedSeqs = new Set(embedded.map((row) => row.seq));
  const kind = (seq: number) => {
    const row = bySeq.get(seq);
    if (!row) return "unknown";
    const text = row.text ?? "";
    const label =
      row.type === "assistant_message" && text.includes("openssl x509")
        ? "assistant_tool_call"
        : row.type;
    return args.isNeedle(text) ? `${label} [NEEDLE]` : label;
  };
  const describe = (seq: number, rank: number): Row => ({
    kind: kind(seq),
    rank,
    seq,
    text: (bySeq.get(seq)?.text ?? "").replace(/\s+/g, " ").slice(0, 90),
  });
  const needles = rows
    .filter((row) => args.isNeedle(row.text ?? ""))
    .map((row) => ({
      embedded: embeddedSeqs.has(row.seq),
      kind: kind(row.seq),
      seq: row.seq,
    }));
  const embedder = createConversationEmbedder({
    cost: { conversationId: args.conversationId },
    operation: "conversation_search_embedding",
  });
  for (const query of args.queries) {
    const keyword = (
      await searchConversationEventText(db, {
        conversationId: args.conversationId,
        limit: LEG,
        query,
      })
    ).map((match) => match.event.seq);
    const vector = await embedConversationQuery(embedder, query);
    const distance = guardedCosineDistance({
      column: embeddings.embedding,
      dimensions: embeddings.dimensions,
      query: vector.vector,
      type: "halfvec",
    });
    // Every embedded event, so a needle past the leg limit still gets a rank.
    const meaningAll = (
      await db
        .select({ seq: embeddings.seq, distance })
        .from(embeddings)
        .where(
          and(
            eq(embeddings.conversationId, args.conversationId),
            eq(embeddings.provider, vector.provider),
            eq(embeddings.model, vector.model),
            eq(embeddings.dimensions, vector.vector.length),
          ),
        )
        .orderBy(distance)
    ).map((row) => ({ seq: row.seq, distance: Number(row.distance) }));
    const meaning = meaningAll.slice(0, LEG).map((row) => row.seq);
    const fused = fuseEventRanks([keyword, meaning]);
    const rrf = (seq: number) =>
      [keyword, meaning].reduce((sum, list) => {
        const index = list.indexOf(seq);
        return index < 0 ? sum : sum + 1 / (RRF_K + index + 1);
      }, 0);
    const distanceOf = new Map(
      meaningAll.map((row) => [row.seq, row.distance]),
    );
    const rankIn = (list: readonly number[], seq: number) => {
      const index = list.indexOf(seq);
      return index < 0 ? null : index + 1;
    };
    const report = {
      query,
      model: `${vector.provider}/${vector.model}`,
      searchableEvents: rows.length,
      embeddedEvents: embeddedSeqs.size,
      keywordCandidates: keyword.length,
      needles: needles.map((needle) => ({
        ...needle,
        keywordRank: rankIn(keyword, needle.seq),
        meaningRank: rankIn(
          meaningAll.map((row) => row.seq),
          needle.seq,
        ),
        meaningDistance: distanceOf.get(needle.seq) ?? null,
        fusedRank: rankIn(fused, needle.seq),
        rrf: rrf(needle.seq),
      })),
      keywordTop10: keyword.slice(0, 10).map((seq, i) => describe(seq, i + 1)),
      meaningTop10: meaningAll.slice(0, 10).map((row, i) => ({
        ...describe(row.seq, i + 1),
        distance: row.distance,
      })),
      fusedTop10: fused.slice(0, 10).map((seq, i) => ({
        ...describe(seq, i + 1),
        rrf: rrf(seq),
        distance: distanceOf.get(seq) ?? null,
      })),
    };
    console.log(`RANKDIAG ${JSON.stringify(report)}`);
  }
}
