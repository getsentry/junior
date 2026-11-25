/**
 * The Lead of one Space: the Space's public top-level Conversation that
 * finds, starts, and steers the Space's other Conversations. Its members
 * talk to it, and a unique index keeps one Lead for each Space. Its title
 * is the Space's name.
 */
import { randomUUID } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import { messagesNeedSpaceMembership } from "@/chat/conversations/kind-behavior";
import type { Conversation } from "@/chat/conversations/store";
import {
  recordWebConversationActivity,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import { getConversationStore, getDb } from "@/chat/db";
import { readSpace } from "@/chat/spaces/store";
import { isPostgresErrorCode } from "@/db/postgres-error";
import { juniorConversations } from "@/db/schema";

// Postgres `unique_violation`: another request created the Lead first.
const UNIQUE_VIOLATION = "23505";

/** Return the Lead of a Space, if it has one. */
export async function readSpaceLead(
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
 * Return the Lead of a Space, and create it on first use. The member who
 * creates it is its first Actor. It is public like the Space, and it has its
 * own Destination, so it reads other Conversations by the usual rules.
 */
export async function getSpaceLead(args: {
  member: Pick<User, "displayName" | "email" | "id">;
  space: { id: string; name: string };
}): Promise<Conversation> {
  const existing = await readSpaceLead(args.space.id);
  if (existing) return existing;
  try {
    await recordWebConversationActivity({
      actor: webActorFromUser(args.member),
      conversationId: `local:web:${randomUUID()}`,
      nowMs: Date.now(),
      rootKind: "lead",
      rootSpaceId: args.space.id,
      rootTitle: args.space.name,
      rootVisibility: "public",
    });
  } catch (error) {
    if (!isPostgresErrorCode(error, UNIQUE_VIOLATION)) throw error;
  }
  const created = await readSpaceLead(args.space.id);
  if (!created) throw new Error("The Lead was not saved");
  return created;
}

/**
 * Return the Space of a Lead. Returns nothing for a Conversation that is not
 * a Lead.
 */
export async function readLeadSpaceId(
  conversationId: string,
): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ spaceId: juniorConversations.spaceId })
    .from(juniorConversations)
    .where(
      and(
        eq(juniorConversations.conversationId, conversationId),
        eq(juniorConversations.kind, "lead"),
      ),
    )
    .limit(1);
  return row?.spaceId ?? undefined;
}

/**
 * Return whether a person may send a Message to a Conversation now, as far
 * as its Space decides: only members of a Space that is not archived message
 * its Lead. Every other Conversation leaves the decision to its access rules.
 */
export async function spaceTakesMessagesFrom(
  conversation: Pick<Conversation, "kind" | "spaceId">,
  userId: string,
): Promise<boolean> {
  if (
    !messagesNeedSpaceMembership(conversation.kind) ||
    !conversation.spaceId
  ) {
    return true;
  }
  const space = await readSpace(userId, conversation.spaceId);
  return Boolean(space?.viewerIsMember && !space.archivedAt);
}
