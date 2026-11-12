import type { ObjectAnnotation } from "@sentry/junior-plugin-api";
import { and, eq, isNotNull, or } from "drizzle-orm";
import {
  getDashboardPersonLink,
  parseDashboardPersonLink,
} from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import {
  identityAvatarUrl,
  readUserAvatarUrls,
} from "@/chat/identities/avatar";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import { juniorIdentities, juniorUsers } from "@/db/schema";
import { personObjectCard } from "./cards";

function linkEmail(url: URL): string | undefined {
  if (url.protocol !== "mailto:") return parseDashboardPersonLink(url.href);
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
}

// Only account-linking flows write a GitHub Identity on a User, so its
// handle is verified. This is the same source as `userLookup`.
async function readLinkedGitHubHandle(
  userId: string,
): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ handle: juniorIdentities.handle })
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.userId, userId),
        eq(juniorIdentities.kind, "user"),
        eq(juniorIdentities.provider, "github"),
        isNotNull(juniorIdentities.handle),
      ),
    )
    .orderBy(juniorIdentities.handle)
    .limit(1);
  return row?.handle ?? undefined;
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
  const db = getDb();
  const rows = await db
    .select({
      avatarUrl: juniorIdentities.avatarUrl,
      displayName: juniorIdentities.displayName,
      email: juniorIdentities.email,
      handle: juniorIdentities.handle,
      identityId: juniorIdentities.id,
      provider: juniorIdentities.provider,
      userDisplayName: juniorUsers.displayName,
      userEmail: juniorUsers.primaryEmail,
      userId: juniorIdentities.userId,
    })
    .from(juniorIdentities)
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        eq(juniorIdentities.kind, "user"),
        or(
          eq(juniorUsers.primaryEmailNormalized, email),
          eq(juniorIdentities.emailNormalized, email),
        ),
      ),
    );
  // The Slack Identity has the handle and the preferred photo.
  const row = rows.find((item) => item.provider === "slack") ?? rows[0];
  const personEmail = row?.userEmail ?? row?.email;
  const canonicalUrl = personEmail
    ? getDashboardPersonLink(personEmail)
    : undefined;
  if (!row || !personEmail || !canonicalUrl) return undefined;
  const avatarUrl = identityAvatarUrl(
    row,
    await readUserAvatarUrls(db, row.userId ? [row.userId] : []),
  );
  const fullName = row.userDisplayName?.trim() || row.displayName?.trim();
  const githubHandle = row.userId
    ? await readLinkedGitHubHandle(row.userId)
    : undefined;
  return personObjectCard({
    ...(githubHandle ? { githubHandle } : undefined),
    person: {
      email: personEmail,
      ...(avatarUrl ? { avatarUrl } : undefined),
      ...(fullName ? { fullName } : undefined),
      ...(row.provider === "slack" && row.handle
        ? { slackUserName: row.handle }
        : undefined),
    },
    url: canonicalUrl,
  });
}
