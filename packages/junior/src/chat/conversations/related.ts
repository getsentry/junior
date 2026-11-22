/**
 * Related Conversations for the first Turn of a person in a root
 * Conversation. The agent sees open Conversations that may cover the same
 * work before it starts, so it can point the person to work that someone
 * already does. Search uses the access of the requester. See
 * `searchConversations`.
 */
import { botConfig } from "@/chat/config";
import { rerankTexts } from "@/chat/core-model";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import { createConversationEmbedder } from "@/chat/conversations/embedding";
import {
  searchConversations,
  type ConversationSearchResult,
} from "@/chat/conversations/search";
import type { ConversationStatus } from "@/chat/conversations/store";
import { logException, logWarn, withSpan } from "@/chat/logging";
import { isProviderRetryError } from "@/chat/services/provider-error";

const CANDIDATE_LIMIT = 10;
const MAX_RELATED = 3;
const MAX_QUERY_CHARS = 2_000;
const RECENT_ACTIVITY_MS = 14 * 24 * 60 * 60 * 1_000;
// Lowest reranker score that admits a Conversation. Not tuned for
// Conversation summaries yet. It starts at the floor that Memory recall
// measured with the same reranking model (`chat/memory/recall.ts`).
const MIN_RERANK_SCORE = 0.55;

/** One open Conversation that may cover the same work as a new request. */
export interface RelatedConversation {
  channelName?: string;
  conversationId: string;
  dashboardUrl?: string;
  /** What its agent does now. A failed Turn waits for input, so it is idle. */
  status: Exclude<ConversationStatus, "failed">;
  summary: string;
  title?: string;
  updatedAtMs: number;
}

type SummarizedResult = ConversationSearchResult & { summary: string };

function rerankDocument(result: SummarizedResult): string {
  return result.title ? `${result.title}\n${result.summary}` : result.summary;
}

function toRelatedConversation(result: SummarizedResult): RelatedConversation {
  const dashboardUrl = getDashboardConversationLink(result.conversationId);
  return {
    ...(result.channelName ? { channelName: result.channelName } : undefined),
    conversationId: result.conversationId,
    ...(dashboardUrl ? { dashboardUrl } : undefined),
    status: result.status === "failed" ? "idle" : result.status,
    summary: result.summary,
    ...(result.title ? { title: result.title } : undefined),
    updatedAtMs: result.updatedAtMs,
  };
}

/**
 * Find open root Conversations with recent activity that may cover the same
 * work as `text`, best first. The reranker decides relevance, so most
 * requests get none. This context is optional: a failure is reported and
 * returns none, and the Turn continues.
 */
export async function findRelatedConversations(args: {
  conversationId: string;
  nowMs: number;
  text: string;
  turnId: string;
}): Promise<RelatedConversation[]> {
  const query = args.text.trim().slice(0, MAX_QUERY_CHARS);
  if (!query) return [];
  return await withSpan(
    "conversation.related",
    "conversation.related",
    {},
    async (setSpanAttributes) => {
      const cost = { conversationId: args.conversationId, turnId: args.turnId };
      try {
        const results = await searchConversations(getDb(), {
          embedder: createConversationEmbedder({
            cost,
            operation: "conversation_search_embedding",
          }),
          requesterConversationId: args.conversationId,
          search: {
            afterMs: args.nowMs - RECENT_ACTIVITY_MS,
            includeArchived: false,
            limit: CANDIDATE_LIMIT,
            query,
            rootsOnly: true,
          },
        });
        // A Conversation has no summary until its first Turn completes.
        const candidates = results.filter(
          (result): result is SummarizedResult => Boolean(result.summary),
        );
        setSpanAttributes({
          "app.related_conversations.candidate.count": candidates.length,
        });
        if (candidates.length === 0) return [];
        const { scores } = await rerankTexts({
          cost,
          documents: candidates.map(rerankDocument),
          modelId: botConfig.rerankingModelId,
          operation: "related_conversation_rerank",
          query,
        });
        // Sort is stable, so equal scores keep search rank order.
        const related = candidates
          .map((result, index) => ({ result, score: scores[index]! }))
          .filter(({ score }) => score >= MIN_RERANK_SCORE)
          .sort((left, right) => right.score - left.score)
          .slice(0, MAX_RELATED)
          .map(({ result }) => toRelatedConversation(result));
        setSpanAttributes({
          "app.related_conversations.injected.count": related.length,
          "app.related_conversations.score.max": Math.max(...scores),
        });
        return related;
      } catch (error) {
        // Log only the error class of a transient provider failure. Provider
        // messages can echo request text.
        if (isProviderRetryError(error)) {
          logWarn("conversation.related.failed", { "error.type": error.kind });
        } else {
          logException(error, "conversation.related.failed");
        }
        return [];
      }
    },
  );
}
