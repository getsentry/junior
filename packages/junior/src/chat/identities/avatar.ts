/**
 * Profile photos of people, saved on their native Slack and Google
 * identities. The dashboard loads each photo straight from the provider.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorIdentities } from "@/db/schema";
import { GOOGLE_IDENTITY_PROVIDER } from "./identity";

// Prefer the Slack photo. Use the Google photo when there is no Slack photo.
const AVATAR_PROVIDERS = ["slack", GOOGLE_IDENTITY_PROVIDER];

/**
 * Return the URL when it is HTTPS on one of the hosts or their subdomains.
 * Dashboard pages load these URLs, so a provider value must not point
 * anywhere else.
 */
export function parseAvatarUrl(
  value: string | null | undefined,
  hosts: readonly string[],
): string | undefined {
  if (!value || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  return hosts.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  )
    ? url.href
    : undefined;
}

/**
 * Read the profile photo of each user: the Slack photo, then the Google
 * photo. Users without a photo are not in the map.
 */
export async function readUserAvatarUrls(
  db: JuniorDatabase,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({
      avatarUrl: juniorIdentities.avatarUrl,
      provider: juniorIdentities.provider,
      updatedAt: juniorIdentities.updatedAt,
      userId: juniorIdentities.userId,
    })
    .from(juniorIdentities)
    .where(
      and(
        inArray(juniorIdentities.userId, [...new Set(userIds)]),
        eq(juniorIdentities.kind, "user"),
        inArray(juniorIdentities.provider, AVATAR_PROVIDERS),
        isNotNull(juniorIdentities.avatarUrl),
      ),
    );
  const rank = (row: (typeof rows)[number]) =>
    AVATAR_PROVIDERS.indexOf(row.provider);
  rows.sort(
    (left, right) =>
      rank(left) - rank(right) ||
      right.updatedAt.getTime() - left.updatedAt.getTime(),
  );
  const avatars = new Map<string, string>();
  for (const row of rows) {
    if (row.userId && row.avatarUrl && !avatars.has(row.userId)) {
      avatars.set(row.userId, row.avatarUrl);
    }
  }
  return avatars;
}
