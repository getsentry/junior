/**
 * Profile photos of people, saved on their native Slack and Google
 * identities. Junior serves each photo from its own API, so browsers never
 * load a photo from Slack or Google.
 */
import { createHash } from "node:crypto";
import type { StateAdapter } from "chat";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { detectImageMediaType } from "@/chat/attachments/media";
import { logWarn } from "@/chat/logging";
import { createCache } from "@/chat/state/cache";
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

const AVATAR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Retry a failed photo soon, but do not fetch it again on each page load.
const AVATAR_FAILURE_TTL_MS = 5 * 60 * 1000;
const AVATAR_FETCH_TIMEOUT_MS = 5_000;
const MAX_AVATAR_BYTES = 1024 * 1024;

/** One profile photo, ready to send to the browser. */
interface AvatarImage {
  contentType: string;
  /** Base64 image bytes, so the state cache can store them as JSON. */
  data: string;
}

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

// The Junior API path that serves the photo of one Identity.
function avatarPath(identityId: string): string {
  return `/api/people/avatars/${encodeURIComponent(identityId)}`;
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
  const rank = (row: (typeof rows)[number]) =>
    AVATAR_PROVIDERS.indexOf(row.provider);
  rows.sort(
    (left, right) =>
      rank(left) - rank(right) ||
      right.updatedAt.getTime() - left.updatedAt.getTime(),
  );
  const avatars = new Map<string, string>();
  for (const row of rows) {
    if (row.userId && !avatars.has(row.userId)) {
      avatars.set(row.userId, avatarPath(row.identityId));
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
  return row.avatarUrl ? avatarPath(row.identityId) : undefined;
}

// Read at most `maxBytes` of the body. Return undefined when it is larger.
async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
}

function avatarFetchFailed(
  host: string,
  attributes: Record<string, string | number>,
): null {
  logWarn("avatar.fetch.failed", { "server.address": host, ...attributes });
  return null;
}

async function fetchAvatarImage(url: string): Promise<AvatarImage | null> {
  const host = new URL(url).hostname;
  let data: Uint8Array | undefined;
  try {
    // No redirects: a redirect could leave the provider photo hosts.
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return avatarFetchFailed(host, {
        "http.response.status_code": response.status,
      });
    }
    data = await readBoundedBody(response, MAX_AVATAR_BYTES);
  } catch (error) {
    return avatarFetchFailed(host, {
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
  }
  if (!data) return avatarFetchFailed(host, { "app.reason": "too_large" });
  // Use the bytes, not the provider header, to pick the content type.
  const contentType = detectImageMediaType(data);
  if (!contentType) {
    return avatarFetchFailed(host, { "app.reason": "not_an_image" });
  }
  return { contentType, data: Buffer.from(data).toString("base64") };
}

/**
 * Read the saved photo of one Identity. Junior fetches it from the provider
 * once and keeps it in the state cache for a day. Return undefined when the
 * Identity has no photo or the provider does not return one.
 */
export async function readAvatarImage(
  db: JuniorDatabase,
  state: StateAdapter,
  identityId: string,
): Promise<AvatarImage | undefined> {
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
  if (!url) return undefined;
  // A new photo has a new URL, so the key changes with the photo.
  const key = `avatar:${createHash("sha256").update(url).digest("hex")}`;
  const image = await createCache(state, "core").getOrLoad(key, async () => {
    const loaded = await fetchAvatarImage(url);
    return {
      value: loaded,
      ttlMs: loaded ? AVATAR_CACHE_TTL_MS : AVATAR_FAILURE_TTL_MS,
    };
  });
  return image ?? undefined;
}
