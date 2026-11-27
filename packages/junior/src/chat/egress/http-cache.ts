/**
 * HTTP cache of provider GET responses through `@sentry/http`, per credential
 * scope and request. A stale entry revalidates with `ETag` or
 * `Last-Modified`; a 304 is free on many providers. Bodies are compressed,
 * not encrypted, under hashed keys, so a state adapter breach exposes up to
 * 6 hours of provider reads, such as commit author emails, but no token.
 */
import { createHash } from "node:crypto";
import { type CacheEntry, type CacheStore, fetchWithCache } from "@sentry/http";
import { createBodyCodec } from "@sentry/http/codec";
import * as z from "zod";
import { getStateAdapter } from "@/chat/state/adapter";

/** How long an entry stays after it goes stale, for revalidation and errors. */
const RETAIN_MS = 6 * 60 * 60_000;

/** Larger stored bodies, such as long commit lists, are not saved. */
const MAX_STORED_BODY_BYTES = 256 * 1024;

const codec = createBodyCodec();

// The state adapter holds JSON, so the encoded body bytes are base64.
const storedEntrySchema = z.object({
  url: z.string(),
  identity: z.string(),
  status: z.number(),
  headers: z.record(z.string(), z.string()),
  body: z.object({
    bytes: z.string(),
    encoding: z.enum(["zstd", "br", "identity"]),
    dictId: z.string().optional(),
    rawSize: z.number(),
  }),
  policy: z.unknown(),
  createdAt: z.number(),
});

/** One GET through the cache. */
export interface HttpCacheRead {
  /**
   * Who may read the entry: the credential that `send` uses, such as the
   * credential context of an egress, or a plugin scope. Never shared.
   */
  scope: string;
  /**
   * Serve the last entry when `send` throws or the provider answers 429 or
   * 5xx.
   */
  staleIfError: boolean;
  /**
   * The longest that an entry serves with no request, also when the
   * provider allows longer. `0` revalidates each read.
   */
  ttlMs: number;
  /** The request, without validators. Its URL and `Accept` name the entry. */
  request: Request;
  send(headers: Record<string, string>): Promise<Response>;
  /** Called with the time that an entry served after its TTL was stored. */
  onStale?(storedAtMs: number): void;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stateKey(key: string): string {
  return `junior:http-cache:${key}`;
}

/**
 * A `CacheStore` over the state adapter. It has no `deleteMatching`:
 * hashed keys cannot be found by URL.
 */
function createStateCacheStore(): CacheStore {
  const state = getStateAdapter();
  return {
    async get(key) {
      const stored = storedEntrySchema.safeParse(
        await state.get(stateKey(key)),
      );
      if (!stored.success) return undefined;
      const { body, policy, ...entry } = stored.data;
      return {
        ...entry,
        body: { ...body, bytes: Buffer.from(body.bytes, "base64") },
        policy,
      } satisfies CacheEntry;
    },
    async set(key, entry, ttlMs) {
      // Replace the older entry, so a later read cannot return it.
      if (entry.body.bytes.byteLength > MAX_STORED_BODY_BYTES) {
        await state.delete(stateKey(key));
        return;
      }
      const bytes = Buffer.from(entry.body.bytes).toString("base64");
      await state.set(
        stateKey(key),
        { ...entry, body: { ...entry.body, bytes } },
        ttlMs,
      );
    },
    async delete(key) {
      await state.delete(stateKey(key));
    },
  };
}

/**
 * Read one provider GET through the cache. A read or write failure of the
 * state adapter is a cache miss, so it never fails the provider read.
 */
export async function readThroughHttpCache(
  read: HttpCacheRead,
): Promise<Response> {
  const accept = read.request.headers.get("accept") ?? "";
  return await fetchWithCache({
    store: createStateCacheStore(),
    codec,
    identity: sha256(read.scope),
    url: read.request.url,
    key: sha256(JSON.stringify([read.scope, read.request.url, accept])),
    ...(accept ? { requestHeaders: { accept } } : undefined),
    send: read.send,
    ttlMs: read.ttlMs,
    maxTtlMs: read.ttlMs,
    retainMs: RETAIN_MS,
    staleIfError: read.staleIfError,
    ...(read.onStale ? { onStale: read.onStale } : undefined),
  });
}
