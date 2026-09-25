import { desc, eq } from "drizzle-orm";
import type { User } from "@sentry/junior-plugin-api";
import {
  forkConversation,
  ConversationForkError,
  type ForkConversationCutoff,
} from "@/chat/conversations/fork";
import { webActorFromEmail } from "@/chat/conversations/web-input";
import { getDb, getSqlExecutor } from "@/chat/db";
import { withConversationEventLock } from "@/chat/conversations/sql/event-lock";
import { juniorConversations } from "@/db/schema";
import { readConversationAccessFromSql } from "./access";
import { throwApiError } from "../http";

/** Check source access before copying any retained model history. */
export async function forkConversationForViewer(
  viewer: User,
  sourceConversationId: string,
  body: {
    cutoff: ForkConversationCutoff;
    idempotencyKey: string;
  },
) {
  return withConversationEventLock(
    getSqlExecutor(),
    sourceConversationId,
    async () => {
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
          actor: webActorFromEmail(viewer.email, {
            fullName: viewer.displayName,
          }),
        });
      } catch (error) {
        if (error instanceof ConversationForkError)
          throwApiError(409, error.message);
        throw error;
      }
    },
  );
}

/** Show only fork links whose target the viewer can read. */
export async function readConversationForks(
  conversationId: string,
  viewer?: User,
): Promise<{
  forkedFromConversationId?: string;
  forks: string[];
}> {
  const db = getDb();
  const [source] = await db
    .select({ forkedFrom: juniorConversations.forkedFromConversationId })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId));
  const children = await db
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(eq(juniorConversations.forkedFromConversationId, conversationId))
    .orderBy(desc(juniorConversations.createdAt))
    .limit(50);
  const ids = children.map((child) => child.conversationId);
  const access = await readConversationAccessFromSql(
    db,
    [
      conversationId,
      ...ids,
      ...(source?.forkedFrom ? [source.forkedFrom] : []),
    ],
    viewer,
  );
  if (!access.get(conversationId)?.canViewPrivateContent) return { forks: [] };
  return {
    ...(source?.forkedFrom &&
    access.get(source.forkedFrom)?.canViewPrivateContent
      ? { forkedFromConversationId: source.forkedFrom }
      : undefined),
    forks: ids.filter((id) => access.get(id)?.canViewPrivateContent),
  };
}
