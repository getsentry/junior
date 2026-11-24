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
import { ProviderError } from "@/chat/services/provider-error";
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

// A child agent has its spawn title before its first Turn completes, and a
// Task never gets a summary.
function rerankDocument(result: ConversationSearchResult): string | undefined {
  const text = [result.title, result.summary].filter(Boolean).join("\n");
  return text || undefined;
}

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

// A child agent's work shows up in its root, where people follow it, so a
// related child names its root.
async function toRelatedConversation(
  result: ConversationSearchResult,
): Promise<RelatedConversation> {
  const url = getDashboardConversationLink(result.conversationId);
  const root =
    result.rootConversationId === result.conversationId
      ? undefined
      : await getConversationStore().get({
          conversationId: result.rootConversationId,
        });
  const rootUrl = root && getDashboardConversationLink(root.conversationId);
  return {
    ...(result.channelName ? { channelName: result.channelName } : undefined),
    conversationId: result.conversationId,
    ...(url ? { url } : undefined),
    ...(root
      ? {
          root: {
            conversationId: root.conversationId,
            ...(root.title ? { title: root.title } : undefined),
            ...(rootUrl ? { url: rootUrl } : undefined),
          },
        }
      : undefined),
    // A failed Turn waits for input, so its agent is idle.
    status: result.status === "failed" ? "idle" : result.status,
    ...(result.summary ? { summary: result.summary } : undefined),
    ...(result.title ? { title: result.title } : undefined),
    updatedAtMs: result.updatedAtMs,
  };
}

async function rankRelatedConversations(
  ctx: UserPromptContext,
  conversationId: string,
  query: string,
): Promise<RelatedConversation[]> {
  const results = await searchConversations(getDb(), {
    embedder: ctx.embedder,
    requesterConversationId: conversationId,
    search: {
      afterMs: Date.now() - RECENT_ACTIVITY_MS,
      includeArchived: false,
      limit: CANDIDATE_LIMIT,
      query,
      // Child agents too: work that a person asked for in a long-running
      // root often happens in a Thread under it.
      rootsOnly: false,
    },
  });
  const candidates = results.flatMap((result) => {
    const document = rerankDocument(result);
    return document ? [{ document, result }] : [];
  });
  ctx.setSpanAttributes({
    "app.related-conversations.candidate.count": candidates.length,
  });
  if (candidates.length === 0) return [];

  const { scores } = await ctx.reranker.rerank({
    documents: candidates.map(({ document }) => document),
    query,
  });
  // Sort is stable, so equal scores keep search rank order.
  const related = await Promise.all(
    candidates
      .map(({ result }, index) => ({ result, score: scores[index]! }))
      .filter(({ score }) => score >= MIN_RERANK_SCORE)
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_RELATED)
      .map(({ result }) => toRelatedConversation(result)),
  );
  ctx.setSpanAttributes({
    "app.related-conversations.injected.count": related.length,
    "app.related-conversations.score.max": Math.max(...scores),
  });
  return related;
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
  let related: RelatedConversation[];
  try {
    related = await rankRelatedConversations(ctx, ctx.conversationId, query);
  } catch (error) {
    // A provider message can echo the request or other summaries, so log
    // only its kind. Other failures reach the hook host, which logs them.
    if (!(error instanceof ProviderError)) throw error;
    ctx.log.warn("related_conversations_provider_failed", {
      "error.type": error.kind,
    });
    return undefined;
  }
  if (related.length === 0) return undefined;
  return [relatedConversationsContext({ conversations: related })];
}
