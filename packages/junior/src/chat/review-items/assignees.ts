import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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

const ownerRoot = alias(juniorConversations, "review_item_owner_root");

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

/** Return which of the Users take part in one root Conversation. */
export async function conversationParticipantUserIds(
  db: JuniorDatabase,
  rootConversationId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .select({ userId: juniorConversationParticipants.userId })
    .from(juniorConversationParticipants)
    .where(
      and(
        eq(
          juniorConversationParticipants.rootConversationId,
          rootConversationId,
        ),
        inArray(juniorConversationParticipants.userId, [...userIds]),
      ),
    );
  return new Set(rows.map((row) => row.userId));
}

/**
 * Return the User of the Owner of a Conversation's root, when the Owner is a
 * person with a Junior User. The system Identity of an Automation run or a
 * plugin dispatch is not a person, so it returns undefined.
 */
export async function conversationOwnerUserId(
  db: JuniorDatabase,
  conversationId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ userId: juniorIdentities.userId })
    .from(juniorConversations)
    .innerJoin(
      ownerRoot,
      eq(ownerRoot.conversationId, juniorConversations.rootConversationId),
    )
    .innerJoin(
      juniorIdentities,
      and(
        eq(juniorIdentities.id, ownerRoot.actorIdentityId),
        eq(juniorIdentities.kind, "user"),
      ),
    )
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  return row?.userId ?? undefined;
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
