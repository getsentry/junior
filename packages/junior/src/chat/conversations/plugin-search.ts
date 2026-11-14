import type { PluginConversationToolContext } from "@sentry/junior-plugin-api";
import {
  searchConversations,
  type ConversationSearch,
} from "@/chat/conversations/search";
import { getDb } from "@/chat/db";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const WORKING_STATUSES = ["pending", "running", "paused"] as const;

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
      const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      // A root is not listed for the Annotation of its child agent, so its
      // status does not stand for the child's work.
      const search: ConversationSearch = {
        annotation: input.annotation,
        annotationOnSelf: true,
        includeArchived: false,
        limit,
        rootsOnly: false,
      };
      const find = async (filters: Partial<ConversationSearch>) =>
        await searchConversations(getDb(), {
          requesterConversationId: conversationId,
          search: { ...search, ...filters },
        });
      // Working Conversations first, so newer idle ones cannot push them
      // past the limit.
      const [working, newest] = await Promise.all([
        find({ statuses: WORKING_STATUSES }),
        find({}),
      ]);
      const seen = new Set(working.map((match) => match.conversationId));
      const matches = [
        ...working,
        ...newest.filter((match) => !seen.has(match.conversationId)),
      ].slice(0, limit);
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
