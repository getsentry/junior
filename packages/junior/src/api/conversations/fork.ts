import type { User } from "@sentry/junior-plugin-api";
import {
  ConversationForkError,
  forkConversation,
  keepQuickQuestion,
} from "@/chat/conversations/fork";
import { getDb } from "@/chat/db";
import type { ForkConversationBody } from "../schema/conversation";
import {
  readConversationAccessFromSql,
  type ConversationAccessReader,
} from "./access";
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

/** Fork links of one Conversation, as stored. */
type ConversationForkLinks = {
  /** Forks, oldest first, at most 50. Quick questions are not included. */
  forkIds: string[];
  /** The source of this fork, when it still exists. */
  forkedFrom?: { conversationId: string; title: string | null };
  isChild: boolean;
};

/**
 * Read fork state for the viewer: whether they can fork, and the source and
 * fork links that they can open.
 */
export async function readConversationForks(
  conversationId: string,
  links: ConversationForkLinks,
  readAccess: ConversationAccessReader,
): Promise<{
  canFork: boolean;
  forkedFromConversationId?: string;
  forkedFromTitle?: string;
  forks: string[];
}> {
  const { forkedFrom, forkIds } = links;
  const access = await readAccess([
    conversationId,
    ...forkIds,
    ...(forkedFrom ? [forkedFrom.conversationId] : []),
  ]);
  const canOpen = (id: string) => access.get(id)?.canViewPrivateContent;
  if (!canOpen(conversationId)) return { canFork: false, forks: [] };
  return {
    // Child conversations cannot be forked. See `forkConversation`.
    canFork: !links.isChild,
    forks: forkIds.filter(canOpen),
    ...(forkedFrom && canOpen(forkedFrom.conversationId)
      ? {
          forkedFromConversationId: forkedFrom.conversationId,
          ...(forkedFrom.title
            ? { forkedFromTitle: forkedFrom.title }
            : undefined),
        }
      : undefined),
  };
}
