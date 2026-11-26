/**
 * The Lead of one Space: the Space's top-level Conversation that finds,
 * starts, and steers the Space's other Conversations. It has the Space's
 * visibility. Its members talk to it, and a unique index keeps one Lead for
 * each Space. Its title is the Space's name.
 */
import type { User } from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import type { Conversation } from "@/chat/conversations/store";
import { getConversationStore, getDb } from "@/chat/db";
import { createSpaceLead, type Space } from "@/chat/spaces/store";
import { isPostgresErrorCode } from "@/db/postgres-error";
import { juniorConversations } from "@/db/schema";

// Postgres `unique_violation`: another request created the Lead first.
const UNIQUE_VIOLATION = "23505";

/** Return the Lead of a Space, if it has one. */
async function readSpaceLead(
  spaceId: string,
): Promise<Conversation | undefined> {
  const [row] = await getDb()
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(
      and(
        eq(juniorConversations.kind, "lead"),
        eq(juniorConversations.spaceId, spaceId),
      ),
    )
    .limit(1);
  return row
    ? await getConversationStore().get({ conversationId: row.conversationId })
    : undefined;
}

/**
 * Return the Lead of a Space, and create it when it is missing. A Space
 * gets its Lead when it is created, so this is only for a Lead that a
 * failed create left out.
 */
export async function getSpaceLead(args: {
  member: Pick<User, "displayName" | "email" | "id">;
  space: Pick<Space, "id" | "name" | "visibility">;
}): Promise<Conversation> {
  const existing = await readSpaceLead(args.space.id);
  if (existing) return existing;
  try {
    await createSpaceLead(args);
  } catch (error) {
    if (!isPostgresErrorCode(error, UNIQUE_VIOLATION)) throw error;
  }
  const created = await readSpaceLead(args.space.id);
  if (!created) throw new Error("The Lead was not saved");
  return created;
}
