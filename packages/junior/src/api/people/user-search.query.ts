import {
  and,
  asc,
  eq,
  exists,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/chat/db";
import { readUserAvatarUrls } from "@/chat/identities/avatar";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationParticipants,
  juniorIdentities,
  juniorConversations,
  juniorUsers,
} from "@/db/schema";
import { slackPersonPredicate } from "@/db/schema/identities";
import type { UserSearchResult } from "../schema/user-search";

// More words only narrow the match further.
const USER_SEARCH_TERMS = 4;

/**
 * What the found Users would join. A Conversation with a Slack workspace
 * finds only Users with a Slack account there, because Invite names them
 * by that account. A Conversation without one needs any Slack account.
 */
export type UserSearchTarget =
  | { kind: "space"; spaceId: string }
  | {
      kind: "conversation";
      rootConversationId: string;
      slackTeamId: string | undefined;
    };

/**
 * Split typed text into lowercase search terms. A leading `@` of a Slack
 * handle is not part of it.
 */
export function userSearchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/^@+/, ""))
    .filter(Boolean)
    .slice(0, USER_SEARCH_TERMS);
}

/**
 * Find Users whose name, Slack name, Slack handle, or primary email holds
 * each word of the query. An exact match of a whole field ranks first, then
 * a field or a word of the name that starts with the query, then any other
 * match. Ties sort by name, then email, then User id, so the order is
 * stable. Users are people: Slack bots and service accounts have none.
 */
export async function readUserSearchFromSql(args: {
  limit: number;
  query: string;
  target: UserSearchTarget;
}): Promise<UserSearchResult[]> {
  const terms = userSearchTerms(args.query);
  if (terms.length === 0) return [];
  const whole = terms.join(" ");
  const { target } = args;
  const db = getDb();
  const slack = alias(juniorIdentities, "user_search_slack");
  const slackJoin = and(
    eq(slack.userId, juniorUsers.id),
    slackPersonPredicate(slack),
    target.kind === "conversation" && target.slackTeamId
      ? eq(slack.providerTenantId, target.slackTeamId)
      : undefined,
  );

  const name = sql<string>`lower(coalesce(${juniorUsers.displayName}, ${slack.displayName}, ''))`;
  const handle = sql<string>`lower(coalesce(${slack.handle}, ''))`;
  const email = juniorUsers.primaryEmailNormalized;
  const document = sql`(${name} || ' ' || lower(coalesce(${slack.displayName}, '')) || ' ' || ${handle} || ' ' || ${email})`;
  const exact = sql`(${name} = ${whole} or ${handle} = ${whole} or ${email} = ${whole} or split_part(${email}, '@', 1) = ${whole})`;
  const prefix = sql`(starts_with(${name}, ${whole}) or starts_with(${handle}, ${whole}) or starts_with(${email}, ${whole}) or strpos(' ' || ${name}, ' ' || ${whole}) > 0)`;
  const rank = sql<number>`case when ${exact} then 0 when ${prefix} then 1 else 2 end`;

  const base = db
    .selectDistinctOn([juniorUsers.id], {
      email: juniorUsers.primaryEmail,
      emailNormalized: email,
      fullName: sql<
        string | null
      >`coalesce(${juniorUsers.displayName}, ${slack.displayName})`.as(
        "full_name",
      ),
      rank: rank.as("rank"),
      slackUserId: slack.providerSubjectId,
      slackUserName: slack.handle,
      sortName: name.as("sort_name"),
      userId: juniorUsers.id,
    })
    .from(juniorUsers);
  const joined =
    target.kind === "conversation"
      ? base.innerJoin(slack, slackJoin)
      : base.leftJoin(slack, slackJoin);
  // Each User keeps the Slack account that ranks best.
  const matches = joined
    .where(and(...terms.map((term) => sql`strpos(${document}, ${term}) > 0`)))
    .orderBy(juniorUsers.id, asc(rank), asc(slack.id))
    .as("user_search_matches");

  const rows = await db
    .select({
      email: matches.email,
      fullName: matches.fullName,
      isMember: memberSql(db, target, matches.userId).as("is_member"),
      slackUserId: matches.slackUserId,
      slackUserName: matches.slackUserName,
      userId: matches.userId,
    })
    .from(matches)
    .orderBy(
      asc(matches.rank),
      asc(matches.sortName),
      asc(matches.emailNormalized),
      asc(matches.userId),
    )
    .limit(args.limit);

  const avatars = await readUserAvatarUrls(
    db,
    rows.map((row) => row.userId),
  );
  return rows.map((row) => {
    const fullName = row.fullName?.trim();
    const avatarUrl = avatars.get(row.userId);
    return {
      email: row.email,
      userId: row.userId,
      ...(fullName ? { fullName } : undefined),
      ...(row.slackUserName ? { slackUserName: row.slackUserName } : undefined),
      ...(target.kind === "conversation" && row.slackUserId
        ? { slackUserId: row.slackUserId }
        : undefined),
      ...(avatarUrl ? { avatarUrl } : undefined),
      ...(row.isMember ? { isMember: true as const } : undefined),
    };
  });
}

/** SQL: the User is already a Member of the Space or a Participant. */
function memberSql(
  db: JuniorDatabase,
  target: UserSearchTarget,
  userId: AnyColumn,
): SQL<boolean> {
  if (target.kind === "space") {
    // A Space's members are the Participants of its Lead.
    const lead = alias(juniorConversations, "user_search_space_lead");
    return sql<boolean>`${exists(
      db
        .select({ userId: juniorConversationParticipants.userId })
        .from(juniorConversationParticipants)
        .innerJoin(
          lead,
          eq(
            lead.conversationId,
            juniorConversationParticipants.rootConversationId,
          ),
        )
        .where(
          and(
            eq(lead.kind, "lead"),
            eq(lead.spaceId, target.spaceId),
            eq(juniorConversationParticipants.userId, userId),
          ),
        ),
    )}`;
  }
  const participants = juniorConversationParticipants;
  return sql<boolean>`${exists(
    db
      .select({ userId: participants.userId })
      .from(participants)
      .where(
        and(
          eq(participants.rootConversationId, target.rootConversationId),
          eq(participants.userId, userId),
        ),
      ),
  )}`;
}
