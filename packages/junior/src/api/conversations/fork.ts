import { asc, eq } from "drizzle-orm";
import type { User } from "@sentry/junior-plugin-api";
import {
  ConversationForkError,
  forkConversation,
} from "@/chat/conversations/fork";
import { getDb } from "@/chat/db";
import { juniorConversations } from "@/db/schema";
import type { ForkConversationBody } from "../schema/conversation";
import { readConversationAccessFromSql } from "./access";
import { throwApiError } from "../http";

/** Fork a Conversation that the viewer can read into a new root they own. */
export async function forkConversationForViewer(
  viewer: User,
  sourceConversationId: string,
  body: ForkConversationBody,
): Promise<{ conversationId: string }> {
  const access = await readConversationAccessFromSql(
    getDb(),
    [sourceConversationId],
    viewer,
  );
  if (!access.get(sourceConversationId)?.canViewPrivateContent) {
    throwApiError(403, "You do not have access to this conversation.");
  }
  try {
    return await forkConversation({
      sourceConversationId,
      ...body,
      actorEmail: viewer.email,
      ...(viewer.displayName ? { actorName: viewer.displayName } : undefined),
    });
  } catch (error) {
    if (error instanceof ConversationForkError) {
      throwApiError(409, error.message);
    }
    throw error;
  }
}

/** Read fork state for the viewer: whether they can fork, and readable links. */
export async function readConversationForks(
  conversationId: string,
  viewer?: User,
): Promise<{
  canFork: boolean;
  forkedFromConversationId?: string;
  forks: string[];
}> {
  const db = getDb();
  const [row] = await db
    .select({
      forkedFrom: juniorConversations.forkedFromConversationId,
      parent: juniorConversations.parentConversationId,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId));
  const forks = await db
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(eq(juniorConversations.forkedFromConversationId, conversationId))
    .orderBy(asc(juniorConversations.createdAt))
    .limit(50);
  const forkedFrom = row?.forkedFrom ?? undefined;
  const ids = forks.map((fork) => fork.conversationId);
  const access = await readConversationAccessFromSql(
    db,
    [conversationId, ...ids, ...(forkedFrom ? [forkedFrom] : [])],
    viewer,
  );
  const canOpen = (id: string) => access.get(id)?.canViewPrivateContent;
  if (!canOpen(conversationId)) return { canFork: false, forks: [] };
  return {
    // Child conversations cannot be forked. See `forkConversation`.
    canFork: !row?.parent,
    ...(forkedFrom && canOpen(forkedFrom)
      ? { forkedFromConversationId: forkedFrom }
      : undefined),
    forks: ids.filter(canOpen),
  };
}
