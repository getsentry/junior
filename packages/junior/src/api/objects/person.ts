import type { ObjectAnnotation } from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import {
  getDashboardPersonLink,
  parseDashboardPersonLink,
} from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import { userAvatarUrlsFromIdentities } from "@/chat/identities/avatar";
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
  // One indexed read: the User with this primary email, as the People pages
  // find them, and all of their user Identities.
  const rows = await getDb()
    .select({
      avatarUrl: juniorIdentities.avatarUrl,
      displayName: juniorIdentities.displayName,
      handle: juniorIdentities.handle,
      identityId: juniorIdentities.id,
      provider: juniorIdentities.provider,
      updatedAt: juniorIdentities.updatedAt,
      userDisplayName: juniorUsers.displayName,
      userEmail: juniorUsers.primaryEmail,
      userId: juniorUsers.id,
    })
    .from(juniorUsers)
    .innerJoin(
      juniorIdentities,
      and(
        eq(juniorIdentities.userId, juniorUsers.id),
        eq(juniorIdentities.kind, "user"),
      ),
    )
    .where(eq(juniorUsers.primaryEmailNormalized, email));
  const user = rows[0];
  const canonicalUrl = user && getDashboardPersonLink(user.userEmail);
  if (!user || !canonicalUrl) return undefined;
  // The Slack Identity has the handle and the name. Only account-linking
  // flows write a GitHub Identity on a User, so its handle is verified. This
  // is the same source as `userLookup`.
  const slack = rows.find((row) => row.provider === "slack");
  const githubHandle = rows
    .flatMap((row) =>
      row.provider === "github" && row.handle ? [row.handle] : [],
    )
    .sort()[0];
  const avatarUrl = userAvatarUrlsFromIdentities(rows).get(user.userId);
  const fullName =
    user.userDisplayName?.trim() || (slack ?? user).displayName?.trim();
  return personObjectCard({
    ...(githubHandle ? { githubHandle } : undefined),
    person: {
      email: user.userEmail,
      ...(avatarUrl ? { avatarUrl } : undefined),
      ...(fullName ? { fullName } : undefined),
      ...(slack?.handle ? { slackUserName: slack.handle } : undefined),
    },
    url: canonicalUrl,
  });
}
