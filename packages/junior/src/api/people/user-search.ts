import type { User } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { readConversationAccessFromSql } from "../conversations/access";
import { throwApiError } from "../http";
import type { UserSearchQuery, UserSearchResult } from "../schema/user-search";
import {
  readUserSearchFromSql,
  type UserSearchTarget,
} from "./user-search.query";

/**
 * Find Users to add to a Conversation, such as a Space's Lead. The viewer
 * must be able to read it, so who is a Participant does not leak;
 * otherwise it looks missing. The Users are those of this install, which is
 * the tenant of every dashboard Conversation, with or without a Slack
 * account. Whether the viewer may add them stays with the route that adds
 * them.
 */
export async function searchUsersForViewer(
  viewer: User,
  query: UserSearchQuery,
): Promise<UserSearchResult[]> {
  return await readUserSearchFromSql({
    limit: query.limit,
    query: query.q,
    target: await readUserSearchTarget(viewer, query),
  });
}

async function readUserSearchTarget(
  viewer: User,
  query: UserSearchQuery,
): Promise<UserSearchTarget> {
  const { conversationId } = query;
  const access = (
    await readConversationAccessFromSql(getDb(), [conversationId], viewer)
  ).get(conversationId);
  if (!access?.canViewPrivateContent || !access.rootConversationId) {
    throwApiError(404, "Conversation not found.");
  }
  return { rootConversationId: access.rootConversationId };
}
