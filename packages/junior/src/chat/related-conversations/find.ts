/**
 * Find the open Conversations that may cover the same work as a person's
 * first request in a root Conversation, so the agent can point the person to
 * work that someone already does. Search uses the access of the requester.
 * See `searchConversations`.
 */
import type {
  UserPromptContext,
  UserPromptContribution,
} from "@sentry/junior-plugin-api";
import {
  isPersonInput,
  turnBehavior,
} from "@/chat/conversations/kind-behavior";
import {
  searchConversations,
  type ConversationSearchResult,
} from "@/chat/conversations/search";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import {
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import {
  relatedConversationsContext,
  type RelatedConversation,
} from "./prompt-context";

const CANDIDATE_LIMIT = 10;
const MAX_RELATED = 3;
const MAX_QUERY_CHARS = 2_000;
const RECENT_ACTIVITY_MS = 14 * 24 * 60 * 60 * 1_000;
// Lowest reranker score that admits a Conversation. Not tuned for
// Conversation summaries yet. It starts at the floor that Memory recall
// measured with the same reranking model (`chat/memory/recall.ts`).
const MIN_RERANK_SCORE = 0.55;

type SummarizedResult = ConversationSearchResult & { summary: string };

// Only the first request of a Conversation gets related work. Later Turns
// already know what they work on.
async function isFirstRequest(
  ctx: UserPromptContext,
  conversationId: string,
): Promise<boolean> {
  const conversation = await getConversationStore().get({ conversationId });
  if (
    !conversation ||
    !turnBehavior({
      kind: conversation.kind,
      personInput: isPersonInput(ctx.source.kind),
    }).relatedConversations
  ) {
    return false;
  }
  const { events } = await getConversationEventStore().query(conversationId, {
    limit: 1,
    types: ["assistant_message"],
  });
  return events.length === 0;
}

function toRelatedConversation(result: SummarizedResult): RelatedConversation {
  const dashboardUrl = getDashboardConversationLink(result.conversationId);
  return {
    ...(result.channelName ? { channelName: result.channelName } : undefined),
    conversationId: result.conversationId,
    ...(dashboardUrl ? { dashboardUrl } : undefined),
    // A failed Turn waits for input, so its agent is idle.
    status: result.status === "failed" ? "idle" : result.status,
    summary: result.summary,
    ...(result.title ? { title: result.title } : undefined),
    updatedAtMs: result.updatedAtMs,
  };
}

/**
 * Return the related Conversations context for a person's first request in
 * a root Conversation, or nothing. The reranker decides relevance, so most
 * requests get none.
 */
export async function findRelatedConversations(
  ctx: UserPromptContext,
): Promise<UserPromptContribution[] | undefined> {
  const query = ctx.text.trim().slice(0, MAX_QUERY_CHARS);
  // The text holds only the request of the Turn. A Turn with none, such as
  // an Event or a child agent result, gets no related work.
  if (!query || !ctx.conversationId) return undefined;
  if (!(await isFirstRequest(ctx, ctx.conversationId))) return undefined;

  const results = await searchConversations(getDb(), {
    embedder: ctx.embedder,
    requesterConversationId: ctx.conversationId,
    search: {
      afterMs: Date.now() - RECENT_ACTIVITY_MS,
      includeArchived: false,
      limit: CANDIDATE_LIMIT,
      query,
      rootsOnly: true,
      // A Conversation has no summary until its first Turn completes, and
      // the reranker needs one. Filter before the limit.
      summarizedOnly: true,
    },
  });
  const candidates = results.filter((result): result is SummarizedResult =>
    Boolean(result.summary),
  );
  ctx.setSpanAttributes({
    "app.related-conversations.candidate.count": candidates.length,
  });
  if (candidates.length === 0) return undefined;

  const { scores } = await ctx.reranker.rerank({
    documents: candidates.map((result) =>
      result.title ? `${result.title}\n${result.summary}` : result.summary,
    ),
    query,
  });
  // Sort is stable, so equal scores keep search rank order.
  const related = candidates
    .map((result, index) => ({ result, score: scores[index]! }))
    .filter(({ score }) => score >= MIN_RERANK_SCORE)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_RELATED)
    .map(({ result }) => toRelatedConversation(result));
  ctx.setSpanAttributes({
    "app.related-conversations.injected.count": related.length,
    "app.related-conversations.score.max": Math.max(...scores),
  });
  if (related.length === 0) return undefined;
  return [relatedConversationsContext({ conversations: related })];
}
