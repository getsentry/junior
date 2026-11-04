import { and, asc, eq, isNull } from "drizzle-orm";
import type { User } from "@sentry/junior-plugin-api";
import {
  ConversationForkError,
  forkConversation,
  keepQuickQuestion,
} from "@/chat/conversations/fork";
import { getDb } from "@/chat/db";
import { juniorConversations } from "@/db/schema";
import type { ForkConversationBody } from "../schema/conversation";
import {
  readConversationAccessFromSql,
  type ConversationAccess,
} from "./access";
import { throwApiError } from "../http";

// A fork makes the viewer the Owner of a copy. A participant who is not the
// Owner of a private source must not gain Owner access to its transcript.
// See `policies/conversation-access.md`.
function canForkConversation(access: ConversationAccess | undefined): boolean {
  return Boolean(
    access?.canViewPrivateContent &&
    (access.visibility === "public" || access.isOwner),
  );
}

/** Fork a Conversation that the viewer may fork into a new root they own. */
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
  if (!canForkConversation(access.get(sourceConversationId))) {
    throwApiError(403, "You do not have access to this conversation.");
  }
  try {
    return await forkConversation({
      sourceConversationId,
      ...body,
      viewer,
    });
  } catch (error) {
    if (error instanceof ConversationForkError) {
      throwApiError(409, error.message);
    }
    throw error;
  }
}

/** Keep the viewer's Quick question as a fork that lists show. */
export async function keepQuickQuestionForViewer(
  viewer: User,
  conversationId: string,
): Promise<{ conversationId: string }> {
  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.isParticipant) {
    throwApiError(404, "Conversation not found.");
  }
  await keepQuickQuestion(conversationId);
  return { conversationId };
}

/**
 * Read fork state for the viewer: whether they can fork, and the source and
 * fork links that they can open.
 */
export async function readConversationForks(
  conversationId: string,
  viewer?: User,
): Promise<{
  canFork: boolean;
  forkedFromConversationId?: string;
  forkedFromTitle?: string;
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
    .where(
      and(
        eq(juniorConversations.forkedFromConversationId, conversationId),
        isNull(juniorConversations.quickQuestionAt),
      ),
    )
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
  const result: {
    canFork: boolean;
    forkedFromConversationId?: string;
    forkedFromTitle?: string;
    forks: string[];
  } = {
    // Child conversations cannot be forked. See `forkConversation`.
    canFork: !row?.parent && canForkConversation(access.get(conversationId)),
    forks: ids.filter(canOpen),
  };
  if (forkedFrom && canOpen(forkedFrom)) {
    const [source] = await db
      .select({ title: juniorConversations.title })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, forkedFrom));
    if (source) {
      result.forkedFromConversationId = forkedFrom;
      if (source.title) result.forkedFromTitle = source.title;
    }
  }
  return result;
}
