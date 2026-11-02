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
// Google photo URLs redirect once to another Google photo host.
const MAX_AVATAR_REDIRECTS = 3;

/** One profile photo, ready to send to the browser. */
interface AvatarImage {
  contentType: string;
  /** Base64 image bytes, so the state cache can store them as JSON. */
  data: string;
}

/** A saved photo and the version of its provider URL. */
interface AvatarRead {
  image: AvatarImage;
  version: string;
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

// A new photo has a new provider URL, so the hash of the URL names the photo.
function avatarUrlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

// The version names one photo of an Identity. It changes with the photo, so
// browsers can keep a versioned photo path for a long time.
function avatarVersion(url: string): string {
  return avatarUrlHash(url).slice(0, 16);
}

// The Junior API path that serves the photo of one Identity.
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

// Fetch the photo. Follow a redirect only to a photo host of the same
// provider, so a redirect cannot leave the provider photo hosts.
async function fetchAvatarResponse(
  url: string,
  provider: string,
  signal: AbortSignal,
): Promise<Response | "redirect_off_host" | "too_many_redirects"> {
  let current = url;
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(current, { redirect: "manual", signal });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      return response;
    }
    await response.body?.cancel();
    const next = URL.canParse(location, current)
      ? parseAvatarUrl(new URL(location, current).href, provider)
      : undefined;
    if (!next) return "redirect_off_host";
    if (redirects >= MAX_AVATAR_REDIRECTS) return "too_many_redirects";
    current = next;
  }
}

async function fetchAvatarImage(
  url: string,
  provider: string,
): Promise<AvatarImage | null> {
  const host = new URL(url).hostname;
  let data: Uint8Array | undefined;
  try {
    const response = await fetchAvatarResponse(
      url,
      provider,
      AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
    );
    if (typeof response === "string") {
      return avatarFetchFailed(host, { "app.reason": response });
    }
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
 * Read the saved photo of one Identity and its version. Junior fetches it
 * from the provider once and keeps it in the state cache for a day. Return
 * undefined when the Identity has no photo or the provider does not return
 * one.
 */
export async function readAvatarImage(
  db: JuniorDatabase,
  state: StateAdapter,
  identityId: string,
): Promise<AvatarRead | undefined> {
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
  if (!row?.avatarUrl || !url) return undefined;
  const key = `avatar:${avatarUrlHash(url)}`;
  const image = await createCache(state, "core").getOrLoad(key, async () => {
    const loaded = await fetchAvatarImage(url, row.provider);
    return {
      value: loaded,
      ttlMs: loaded ? AVATAR_CACHE_TTL_MS : AVATAR_FAILURE_TTL_MS,
    };
  });
  return image ? { image, version: avatarVersion(row.avatarUrl) } : undefined;
}
