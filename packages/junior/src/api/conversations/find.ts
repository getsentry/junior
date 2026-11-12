import type { User } from "@sentry/junior-plugin-api";
import { botConfig } from "@/chat/config";
import { rankFindCandidates } from "@/chat/conversation-find/rank";
import { completeObject } from "@/chat/core-model";
import type { ConversationFeedItem } from "../schema/conversation-feed";
import {
  MAX_CONVERSATION_FIND_MATCHES,
  type ConversationFind,
} from "../schema/conversation-find";
import { readConversationFeedFromSql } from "./list";

// Newest activity first. Enough to cover a few weeks of use at one fast
// model call.
const ACTIVE_CANDIDATES = 150;
const ARCHIVED_CANDIDATES = 50;

function flatten(items: ConversationFeedItem[]): ConversationFeedItem[] {
  return items.flatMap(({ threads, ...item }) => [
    item,
    ...flatten(threads ?? []),
  ]);
}

/**
 * Find the viewer's Conversations that fit a free-text description, for
 * when the title search cannot. Candidates come from the viewer's own feed,
 * so the model sees only Conversations that the viewer can already open.
 */
export async function findConversationsForViewer(
  viewer: User,
  description: string,
): Promise<ConversationFind> {
  const [active, archived] = await Promise.all([
    readConversationFeedFromSql({
      limit: ACTIVE_CANDIDATES,
      status: "active",
      viewer,
    }),
    readConversationFeedFromSql({
      limit: ARCHIVED_CANDIDATES,
      status: "archived",
      viewer,
    }),
  ]);
  const byId = new Map(
    flatten([...active.conversations, ...archived.conversations]).map(
      (item) => [item.conversationId, item],
    ),
  );
  const matches = await rankFindCandidates({
    candidates: [...byId.values()].map((item) => ({
      archived: Boolean(item.archivedAt),
      ...(item.brief ? { brief: item.brief } : undefined),
      id: item.conversationId,
      lastActiveAt: item.lastSeenAt,
      title: item.displayTitle,
    })),
    completeObject,
    description,
    limit: MAX_CONVERSATION_FIND_MATCHES,
    modelId: botConfig.fastModelId,
    nowMs: Date.now(),
  });
  return {
    matches: matches.map((match) => ({
      conversation: byId.get(match.id)!,
      reason: match.reason,
    })),
  };
}
