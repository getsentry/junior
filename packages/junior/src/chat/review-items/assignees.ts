import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { ProviderTenant } from "@/api/conversations/access";
import { findUserByEmailFromSql } from "@/chat/plugins/viewer";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorAutomations,
  juniorConversationParticipants,
  juniorConversations,
  juniorIdentities,
} from "@/db/schema";

/** Text that the agent writes to assign Everyone. */
export const EVERYONE_ASSIGNEE = "everyone";

/** The assignment that an agent asked for, resolved to Users. */
export interface ResolvedAssignees {
  everyone: boolean;
  userIds: string[];
}

/**
 * Find the Junior User of a chat mention, such as `<@U123>`, in one provider
 * tenant. Return undefined when the text is not a mention. Throw a
 * `ToolInputError` when it is a mention without a Junior User. App setup
 * supplies the provider version.
 */
export type FindMentionedUserId = (
  text: string,
  tenant: ProviderTenant | undefined,
) => Promise<string | undefined>;

/**
 * Resolve one assignee: Everyone, an email, or a mention. A mention must be
 * in the tenant of the item.
 */
export async function resolveAssignee(
  db: JuniorDatabase,
  value: string,
  tenant: ProviderTenant | undefined,
  findMentionedUserId: FindMentionedUserId,
): Promise<{ everyone: true } | { userId: string }> {
  const text = value.trim();
  if (text.toLowerCase() === EVERYONE_ASSIGNEE) return { everyone: true };
  const mentionedUserId = await findMentionedUserId(text, tenant);
  if (mentionedUserId) return { userId: mentionedUserId };
  if (text.includes("@")) {
    const user = await findUserByEmailFromSql(db, text);
    if (!user) {
      throw new ToolInputError(`No Junior user has the email ${text}.`);
    }
    return { userId: user.id };
  }
  throw new ToolInputError(
    `Unknown assignee ${JSON.stringify(text)}. Use ${EVERYONE_ASSIGNEE}, an email, or a mention such as <@U123>.`,
  );
}

/** Resolve the assignees of a Review item. One is required. */
export async function resolveAssignees(
  db: JuniorDatabase,
  values: readonly string[],
  tenant: ProviderTenant | undefined,
  findMentionedUserId: FindMentionedUserId,
): Promise<ResolvedAssignees> {
  if (values.length === 0) {
    throw new ToolInputError("A review item needs at least one assignee.");
  }
  const resolved = await Promise.all(
    values.map((value) =>
      resolveAssignee(db, value, tenant, findMentionedUserId),
    ),
  );
  return {
    everyone: resolved.some((assignee) => "everyone" in assignee),
    userIds: [
      ...new Set(
        resolved.flatMap((assignee) =>
          "userId" in assignee ? [assignee.userId] : [],
        ),
      ),
    ],
  };
}

// Participant rows belong to the root, so a child id reads its root's rows.
async function participantUserIds(
  db: JuniorDatabase,
  conversationId: string,
  condition: SQL,
): Promise<string[]> {
  const rows = await db
    .select({ userId: juniorConversationParticipants.userId })
    .from(juniorConversationParticipants)
    .innerJoin(
      juniorConversations,
      eq(
        juniorConversationParticipants.rootConversationId,
        sql`coalesce(${juniorConversations.rootConversationId}, ${juniorConversations.conversationId})`,
      ),
    )
    .where(
      and(eq(juniorConversations.conversationId, conversationId), condition),
    );
  return rows.map((row) => row.userId);
}

/** Return which of the Users are Participants of a Conversation. */
export async function conversationParticipantUserIds(
  db: JuniorDatabase,
  conversationId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  return new Set(
    await participantUserIds(
      db,
      conversationId,
      inArray(juniorConversationParticipants.userId, [...userIds]),
    ),
  );
}

/**
 * Return the active Participants of a Conversation: the people who have not
 * unsubscribed from it.
 */
export async function activeParticipantUserIds(
  db: JuniorDatabase,
  conversationId: string,
): Promise<string[]> {
  return await participantUserIds(
    db,
    conversationId,
    isNull(juniorConversationParticipants.unsubscribedAt),
  );
}

/** Return the User who created an Automation, if Junior knows them. */
export async function automationCreatorUserId(
  db: JuniorDatabase,
  automationId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ userId: juniorIdentities.userId })
    .from(juniorAutomations)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorAutomations.creatorIdentityId),
    )
    .where(eq(juniorAutomations.id, automationId))
    .limit(1);
  return row?.userId ?? undefined;
}
