import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { ProviderTenant } from "@/api/conversations/access";
import { findUserByEmailFromSql } from "@/chat/plugins/viewer";
import { parseSlackUserId } from "@/chat/slack/ids";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationParticipants, juniorIdentities } from "@/db/schema";

/** Text that the agent writes to assign Everyone. */
export const EVERYONE_ASSIGNEE = "everyone";

/** The assignment that an agent asked for, resolved to Users. */
export interface ResolvedAssignees {
  everyone: boolean;
  userIds: string[];
}

const SLACK_MENTION = /^<@([A-Z0-9]+)(?:\|[^>]*)?>$/;

async function userIdForSlackUser(
  db: JuniorDatabase,
  slackUserId: string,
  teamId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ userId: juniorIdentities.userId })
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.provider, "slack"),
        eq(juniorIdentities.providerTenantId, teamId),
        eq(juniorIdentities.providerSubjectId, slackUserId),
        isNotNull(juniorIdentities.userId),
      ),
    )
    .limit(1);
  return rows[0]?.userId ?? undefined;
}

/**
 * Resolve one assignee: Everyone, an email, or a Slack user. A Slack user
 * must be in the Slack workspace of the item.
 */
export async function resolveAssignee(
  db: JuniorDatabase,
  value: string,
  tenant: ProviderTenant | undefined,
): Promise<{ everyone: true } | { userId: string }> {
  const text = value.trim();
  if (text.toLowerCase() === EVERYONE_ASSIGNEE) return { everyone: true };
  const slackUserId = parseSlackUserId(SLACK_MENTION.exec(text)?.[1] ?? text);
  if (slackUserId) {
    const userId =
      tenant?.provider === "slack"
        ? await userIdForSlackUser(db, slackUserId, tenant.providerTenantId)
        : undefined;
    if (!userId) {
      throw new ToolInputError(
        `<@${slackUserId}> has no Junior user yet. Assign them by email.`,
      );
    }
    return { userId };
  }
  if (text.includes("@")) {
    const user = await findUserByEmailFromSql(db, text);
    if (!user) {
      throw new ToolInputError(`No Junior user has the email ${text}.`);
    }
    return { userId: user.id };
  }
  throw new ToolInputError(
    `Unknown assignee ${JSON.stringify(text)}. Use ${EVERYONE_ASSIGNEE}, an email, or a Slack mention such as <@U123>.`,
  );
}

/** Resolve the assignees of a Review item. One is required. */
export async function resolveAssignees(
  db: JuniorDatabase,
  values: readonly string[],
  tenant: ProviderTenant | undefined,
): Promise<ResolvedAssignees> {
  if (values.length === 0) {
    throw new ToolInputError("A review item needs at least one assignee.");
  }
  const resolved = await Promise.all(
    values.map((value) => resolveAssignee(db, value, tenant)),
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
