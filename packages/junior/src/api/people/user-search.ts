import type { User } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import {
  readableSlackTeamId,
  readConversationAccessFromSql,
} from "../conversations/access";
import { throwApiError } from "../http";
import type { UserSearchQuery, UserSearchResult } from "../schema/user-search";
import { requireSpace } from "../spaces/access";
import {
  readUserSearchFromSql,
  type UserSearchTarget,
} from "./user-search.query";

/**
 * Find Users to add to a Space or a Conversation. The viewer must be able
 * to read it, so who is a member does not leak; otherwise it looks
 * missing. The Users are those of this install, which is the tenant of
 * every Space and dashboard Conversation. A Conversation in a Slack
 * workspace narrows them to that workspace. Whether the viewer may add
 * them stays with the route that adds them.
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
  if (query.spaceId) {
    await requireSpace(viewer.id, query.spaceId);
    return { kind: "space", spaceId: query.spaceId };
  }
  const conversationId = query.conversationId!;
  const access = (
    await readConversationAccessFromSql(getDb(), [conversationId], viewer)
  ).get(conversationId);
  if (!access?.canViewPrivateContent || !access.rootConversationId) {
    throwApiError(404, "Conversation not found.");
  }
  return {
    kind: "conversation",
    rootConversationId: access.rootConversationId,
    slackTeamId: readableSlackTeamId(access),
  };
}
