import { and, eq, ne, sql } from "drizzle-orm";
import type { User } from "@sentry/junior-plugin-api";
import { getDb, getSqlExecutor } from "@/chat/db";
import { resolveRootVisibility } from "@/chat/conversations/sql/privacy";
import { juniorConversations, juniorDestinations } from "@/db/schema";
import { throwApiError } from "../http";
import type { PublishConversationResponse } from "../schema/conversation";
import { readConversationAccessFromSql } from "./access";

/**
 * Make one conversation public by flipping its root destination visibility.
 * One-way only: non-public becomes public; already-public stays public.
 */
export async function publishConversationForViewer(
  viewer: User,
  conversationId: string,
): Promise<PublishConversationResponse> {
  const access = (
    await readConversationAccessFromSql(getDb(), [conversationId], viewer)
  ).get(conversationId);
  if (!access) {
    throwApiError(404, "Conversation not found.");
  }
  if (!access.isParticipant) {
    throwApiError(403, "Only conversation participants can make this public.");
  }

  const executor = getSqlExecutor();
  const root = await resolveRootVisibility(executor, conversationId);
  if (root.visibility === null) {
    throwApiError(409, "Conversation has no destination to publish.");
  }

  // Resolve the root destination id under the same privacy authority used by
  // access and retention. Child conversations publish the parent root only.
  const [destination] = await executor
    .db()
    .select({ destinationId: juniorConversations.destinationId })
    .from(juniorConversations)
    .where(
      and(
        eq(juniorConversations.conversationId, root.rootConversationId),
        eq(
          juniorConversations.rootConversationId,
          juniorConversations.conversationId,
        ),
      ),
    )
    .limit(1);

  if (!destination?.destinationId) {
    throwApiError(409, "Conversation has no destination to publish.");
  }

  const updated = await executor
    .db()
    .update(juniorDestinations)
    .set({
      updatedAt: sql`now()`,
      visibility: "public",
    })
    .where(
      and(
        eq(juniorDestinations.id, destination.destinationId),
        ne(juniorDestinations.visibility, "public"),
      ),
    )
    .returning({ id: juniorDestinations.id });

  // Already public is success: one-way publish is idempotent for participants.
  if (updated.length === 0) {
    const [existing] = await executor
      .db()
      .select({ visibility: juniorDestinations.visibility })
      .from(juniorDestinations)
      .where(eq(juniorDestinations.id, destination.destinationId))
      .limit(1);
    if (!existing) {
      throwApiError(404, "Conversation not found.");
    }
  }

  return { visibility: "public" };
}
