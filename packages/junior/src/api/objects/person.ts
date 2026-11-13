import type { ObjectAnnotation } from "@sentry/junior-plugin-api";
import {
  getDashboardPersonLink,
  parseDashboardPersonLink,
} from "@/chat/dashboard-link";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { juniorIdentities, juniorUsers } from "@/db/schema";
import { userAvatarUrlsFromIdentities } from "@/chat/identities/avatar";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import { readCachedUserByEmail } from "@/chat/identities/user-cache";
import { personObjectCard } from "./cards";

function linkEmail(url: URL): string | undefined {
  if (url.protocol !== "mailto:") return parseDashboardPersonLink(url.href);
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a dashboard person link or a `mailto:` link to a known person.
 * The card shows what the People pages show every signed-in viewer (the
 * name, email, Slack handle, and photo) and a verified linked GitHub login.
 */
export async function resolvePersonLink(
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const email = normalizeIdentityEmail(linkEmail(url));
  if (!email) return undefined;
  // The People pages find a person by the primary email of their User.
  const cached = await readCachedUserByEmail(getDb(), email);
  const canonicalUrl =
    cached && getDashboardPersonLink(cached.user.primaryEmail);
  if (!cached || !canonicalUrl) return undefined;
  const { identities, user } = cached;
  // The Slack Identity has the handle and the name. Only account-linking
  // flows write a GitHub Identity on a User, so its handle is verified. This
  // is the same source as `userLookup`.
  const slack = identities.find((identity) => identity.provider === "slack");
  const githubHandle = identities
    .flatMap((identity) =>
      identity.provider === "github" && identity.handle
        ? [identity.handle]
        : [],
    )
    .sort()[0];
  const avatarUrl = userAvatarUrlsFromIdentities(
    identities.map((identity) => ({
      ...identity,
      identityId: identity.id,
      userId: user.id,
    })),
  ).get(user.id);
  // Without a User name, the Slack name wins over the name of any other
  // Identity.
  const fullName = [user, slack, ...identities]
    .map((source) => source?.displayName?.trim())
    .find(Boolean);
  return personObjectCard({
    ...(githubHandle ? { githubHandle } : undefined),
    person: {
      email: user.primaryEmail,
      ...(avatarUrl ? { avatarUrl } : undefined),
      ...(fullName ? { fullName } : undefined),
      ...(slack?.handle ? { slackUserName: slack.handle } : undefined),
    },
    url: canonicalUrl,
  });
}

/**
 * Resolve the card of the one known person who linked this provider account.
 * Only account-linking flows put a provider Identity on a User, so the match
 * is verified. Two people with the same handle get no card.
 */
export async function resolvePersonByAccount(account: {
  handle: string;
  provider: string;
}): Promise<ObjectAnnotation | undefined> {
  const rows = await getDb()
    .selectDistinct({ email: juniorUsers.primaryEmail })
    .from(juniorIdentities)
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        eq(juniorIdentities.kind, "user"),
        eq(juniorIdentities.provider, account.provider),
        isNotNull(juniorIdentities.userId),
        sql`lower(${juniorIdentities.handle}) = lower(${account.handle})`,
      ),
    )
    .limit(2);
  const link = rows.length === 1 && getDashboardPersonLink(rows[0]!.email);
  return link ? await resolvePersonLink(new URL(link)) : undefined;
}
