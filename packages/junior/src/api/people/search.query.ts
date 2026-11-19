import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import {
  identityAvatarUrl,
  readUserAvatarUrls,
} from "@/chat/identities/avatar";
import { juniorIdentities, juniorUsers } from "@/db/schema";
import {
  slackPersonPredicate,
  slackPersonSearchDocument,
} from "@/db/schema/identities";
import type { MentionablePerson } from "../schema/person";

// One menu of names. More rows do not help a person who is still typing.
const PEOPLE_SEARCH_LIMIT = 8;
// More words only narrow the match further.
const PEOPLE_SEARCH_TERMS = 4;

/**
 * Find Slack people whose name or handle has a word that starts with each
 * word of the query, for the composer `@` menu. It reads one index
 * (`junior_identities_slack_person_search_idx`) and the photos of the
 * matches. With `slackTeamId`, it finds only people in that Slack
 * workspace. Without it, a person with Slack accounts in two workspaces
 * shows once.
 */
export async function readPeopleSearchFromSql(
  query: string,
  slackTeamId?: string,
): Promise<MentionablePerson[]> {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(
    0,
    PEOPLE_SEARCH_TERMS,
  );
  if (terms.length === 0) return [];
  // The terms hold only letters and digits, so they cannot add tsquery syntax.
  const tsquery = terms.map((term) => `${term}:*`).join(" & ");
  const db = getDb();
  const rows = await db
    .select({
      avatarUrl: juniorIdentities.avatarUrl,
      displayName: juniorIdentities.displayName,
      emailVerified: juniorIdentities.emailVerified,
      handle: juniorIdentities.handle,
      identityId: juniorIdentities.id,
      providerSubjectId: juniorIdentities.providerSubjectId,
      userDisplayName: juniorUsers.displayName,
      userEmail: juniorUsers.primaryEmail,
      userId: juniorIdentities.userId,
    })
    .from(juniorIdentities)
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        slackPersonPredicate(juniorIdentities),
        sql`${slackPersonSearchDocument(juniorIdentities)} @@ to_tsquery('simple', ${tsquery})`,
        slackTeamId
          ? eq(juniorIdentities.providerTenantId, slackTeamId)
          : undefined,
      ),
    )
    .orderBy(
      asc(
        sql`lower(coalesce(${juniorUsers.displayName}, ${juniorIdentities.displayName}, ${juniorIdentities.handle}))`,
      ),
      asc(juniorIdentities.id),
    )
    .limit(PEOPLE_SEARCH_LIMIT);
  const avatars = await readUserAvatarUrls(
    db,
    rows.flatMap((row) => (row.userId ? [row.userId] : [])),
  );
  const seenUsers = new Set<string>();
  return rows.flatMap((row) => {
    if (row.userId) {
      if (seenUsers.has(row.userId)) return [];
      seenUsers.add(row.userId);
    }
    const fullName = row.userDisplayName?.trim() || row.displayName?.trim();
    // A verified email is the People profile route, as in `resolveMentions`.
    const email = row.emailVerified ? row.userEmail?.trim() : undefined;
    const avatarUrl = identityAvatarUrl(row, avatars);
    return [
      {
        slackUserId: row.providerSubjectId,
        ...(fullName ? { fullName } : undefined),
        ...(row.handle ? { slackUserName: row.handle } : undefined),
        ...(email ? { email } : undefined),
        ...(avatarUrl ? { avatarUrl } : undefined),
      },
    ];
  });
}
