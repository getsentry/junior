import { and, eq, isNull, ne, sql } from "drizzle-orm";
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
 *
 * Refuses destinations shared by other roots so one publish cannot expose
 * unrelated private conversations on the same channel.
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
  const destinationId = destination.destinationId;

  await executor.transaction(async () => {
    // Root creation upserts the destination before it inserts the conversation.
    // Locking this row makes the shared-root check and visibility update atomic
    // against a concurrent root that targets the same destination.
    const [lockedDestination] = await executor
      .db()
      .select({ visibility: juniorDestinations.visibility })
      .from(juniorDestinations)
      .where(eq(juniorDestinations.id, destinationId))
      .for("update");
    if (!lockedDestination) {
      throwApiError(404, "Conversation not found.");
    }

    // Already public is success without re-checking shared roots: the flip is
    // one-way and the destination is already exposed.
    if (lockedDestination.visibility === "public") {
      return;
    }

    const [shared] = await executor
      .db()
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(juniorConversations)
      .where(
        and(
          eq(juniorConversations.destinationId, destinationId),
          isNull(juniorConversations.parentConversationId),
          ne(juniorConversations.conversationId, root.rootConversationId),
        ),
      );
    if ((shared?.count ?? 0) > 0) {
      throwApiError(
        409,
        "This destination is shared by other conversations, so it cannot be made public from one conversation.",
      );
    }

    await executor
      .db()
      .update(juniorDestinations)
      .set({
        updatedAt: sql`now()`,
        visibility: "public",
      })
      .where(eq(juniorDestinations.id, destinationId));
  });

  return { visibility: "public" };
}
