/**
 * Profile photos of people, saved on their native Slack and Google
 * identities. `/api/people/avatars/:identityId` serves each photo through
 * the shared image route code, so browsers never load a photo from Slack or
 * Google.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorIdentities } from "@/db/schema";
import { GOOGLE_IDENTITY_PROVIDER } from "./identity";

// The hosts that serve photos for each provider. The order of the providers
// is the preference: the Slack photo, then the Google photo.
const AVATAR_HOSTS: Record<string, readonly string[]> = {
  slack: ["avatars.slack-edge.com"],
  [GOOGLE_IDENTITY_PROVIDER]: ["googleusercontent.com"],
};
const AVATAR_PROVIDERS = Object.keys(AVATAR_HOSTS);

// The dashboard shows photos at 32 CSS pixels or less. 128 pixels stays sharp
// on 3x screens. Slack sends 512 pixel photos of up to about 600 KB.
export const AVATAR_WIDTH = 128;

type AvatarIdentityRow = {
  avatarUrl: string | null;
  identityId: string;
  userId: string | null;
};

/**
 * Return the URL when it is HTTPS on a photo host of the provider or a
 * subdomain. Junior fetches only these URLs.
 */
export function parseAvatarUrl(
  value: string | null | undefined,
  provider: string,
): string | undefined {
  const hosts = AVATAR_HOSTS[provider];
  if (!hosts || !value || !URL.canParse(value)) return undefined;
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

// A new photo has a new provider URL, so the hash of the URL names the photo.
// The version changes with the photo, so browsers can keep a photo path.
function avatarVersion(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

// The Junior path that serves the photo of one Identity.
function avatarPath(identityId: string, avatarUrl: string): string {
  return `/api/people/avatars/${encodeURIComponent(identityId)}?v=${avatarVersion(avatarUrl)}`;
}

/**
 * Read the photo path of each user: the Slack photo, then the Google photo.
 * Users without a photo are not in the map.
 */
export async function readUserAvatarUrls(
  db: JuniorDatabase,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({
      avatarUrl: juniorIdentities.avatarUrl,
      identityId: juniorIdentities.id,
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
  return userAvatarUrlsFromIdentities(rows);
}

/**
 * Pick the photo path of each user from their user Identities, for a caller
 * that already read them: the Slack photo, then the Google photo.
 */
export function userAvatarUrlsFromIdentities(
  rows: readonly (AvatarIdentityRow & { provider: string; updatedAt: Date })[],
): Map<string, string> {
  const rank = (row: (typeof rows)[number]) =>
    AVATAR_PROVIDERS.indexOf(row.provider);
  const ranked = rows
    .filter((row) => rank(row) >= 0)
    .sort(
      (left, right) =>
        rank(left) - rank(right) ||
        right.updatedAt.getTime() - left.updatedAt.getTime(),
    );
  const avatars = new Map<string, string>();
  for (const row of ranked) {
    if (row.userId && row.avatarUrl && !avatars.has(row.userId)) {
      avatars.set(row.userId, avatarPath(row.identityId, row.avatarUrl));
    }
  }
  return avatars;
}

/**
 * Return the photo path for one Identity row. A linked Identity uses the
 * photo of its user. An Identity without a user uses its own photo.
 */
export function identityAvatarUrl(
  row: AvatarIdentityRow,
  userAvatarUrls: ReadonlyMap<string, string>,
): string | undefined {
  if (row.userId) return userAvatarUrls.get(row.userId);
  return row.avatarUrl ? avatarPath(row.identityId, row.avatarUrl) : undefined;
}

/**
 * Return how to fetch the photo of one user Identity, or nothing when it has
 * no photo on a photo host of its provider. A redirect cannot leave the
 * photo hosts of the provider.
 */
export async function readAvatarFetch(
  db: JuniorDatabase,
  identityId: string,
): Promise<{ hosts: readonly string[]; url: string } | undefined> {
  const [row] = await db
    .select({
      avatarUrl: juniorIdentities.avatarUrl,
      provider: juniorIdentities.provider,
    })
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.id, identityId),
        eq(juniorIdentities.kind, "user"),
      ),
    )
    .limit(1);
  const url = row ? parseAvatarUrl(row.avatarUrl, row.provider) : undefined;
  const hosts = row && AVATAR_HOSTS[row.provider];
  return url && hosts ? { hosts, url } : undefined;
}
