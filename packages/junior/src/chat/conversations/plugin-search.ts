import type { PluginConversationToolContext } from "@sentry/junior-plugin-api";
import { searchConversations } from "@/chat/conversations/search";
import { getDb } from "@/chat/db";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

/**
 * Let a plugin tool find other Conversations by Annotation key. The current
 * Conversation is the requester, so the access rules of `searchConversations`
 * apply and its own tree is never a result.
 */
export function createPluginConversations(
  conversationId: string,
): PluginConversationToolContext {
  return {
    async search(input) {
      const matches = await searchConversations(getDb(), {
        requesterConversationId: conversationId,
        search: {
          annotation: input.annotation,
          includeArchived: false,
          limit: Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
          rootsOnly: false,
        },
      });
      return matches.map((match) => ({
        conversationId: match.conversationId,
        // Only a child agent has a different root.
        ...(match.rootConversationId !== match.conversationId
          ? { rootConversationId: match.rootConversationId }
          : undefined),
        // A Conversation whose Turn failed waits for new input.
        status: match.status === "failed" ? "idle" : match.status,
        ...(match.summary ? { summary: match.summary } : undefined),
        ...(match.title ? { title: match.title } : undefined),
        updatedAt: new Date(match.updatedAtMs).toISOString(),
      }));
    },
  };
}
