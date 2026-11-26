/**
 * Junior's HTTP cache of provider GET responses. Each entry belongs to one
 * credential scope and one request, so a response that one credential read
 * never serves another credential. A fresh entry serves with no request. A
 * stale one asks the provider with its `ETag` or `Last-Modified`, and a
 * `304 Not Modified` stores it again. Many providers, such as GitHub, do
 * not count a 304 against the rate limit.
 *
 * Saved bodies are plaintext in the state adapter, under hashed keys. A
 * breach of that store exposes up to 6 hours of provider reads: object
 * card data that viewers and the system Actor read, and plugin webhook
 * reads, such as pull requests, their commits with author names and
 * emails, and collaborator roles. It exposes no token.
 */
import { createHash } from "node:crypto";
import * as z from "zod";
import { getStateAdapter } from "@/chat/state/adapter";

/** How long an entry stays after its TTL, for revalidation and errors. */
const RETAIN_MS = 6 * 60 * 60_000;

/** Larger bodies, such as long commit lists, are not saved. */
const MAX_SAVED_BODY_BYTES = 256 * 1024;

// Only the headers that readers of a cached body use.
const KEPT_HEADERS = ["content-type", "etag", "last-modified", "link"];

const entrySchema = z.object({
  body: z.string(),
  headers: z.record(z.string(), z.string()),
  storedAtMs: z.number(),
});
type Entry = z.output<typeof entrySchema>;

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
  /** How long an entry serves with no request. `0` revalidates each read. */
  ttlMs: number;
  /** The request, without validators. Its URL and `Accept` name the entry. */
  request: Request;
  send(headers: Record<string, string>): Promise<Response>;
  /** Called with the time that an entry served after its TTL was stored. */
  onStale?(storedAtMs: number): void;
}

function entryKey(read: HttpCacheRead): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        read.scope,
        read.request.url,
        read.request.headers.get("accept") ?? "",
      ]),
    )
    .digest("hex");
  return `junior:http-cache:${hash}`;
}

function cachedResponse(entry: Entry): Response {
  return new Response(Buffer.from(entry.body, "base64"), {
    headers: entry.headers,
    status: 200,
  });
}

function validators(entry: Entry | undefined): Record<string, string> {
  const etag = entry?.headers["etag"];
  const lastModified = entry?.headers["last-modified"];
  return {
    ...(etag ? { "If-None-Match": etag } : undefined),
    ...(lastModified ? { "If-Modified-Since": lastModified } : undefined),
  };
}

/**
 * Read one provider GET through the cache. A read or write failure of the
 * state adapter is a cache miss, so it never fails the provider read.
 */
export async function readThroughHttpCache(
  read: HttpCacheRead,
): Promise<Response> {
  const state = getStateAdapter();
  const key = entryKey(read);
  const saved = entrySchema.safeParse(
    await state
      .connect()
      .then(async () => await state.get(key))
      .catch(() => undefined),
  ).data;
  if (saved && Date.now() - saved.storedAtMs < read.ttlMs) {
    return cachedResponse(saved);
  }
  const store = async (entry: Entry) =>
    await state.set(key, entry, read.ttlMs + RETAIN_MS).catch(() => undefined);
  const stale = () => {
    if (!saved || !read.staleIfError) return undefined;
    read.onStale?.(saved.storedAtMs);
    return cachedResponse(saved);
  };
  let response: Response;
  try {
    response = await read.send(validators(saved));
  } catch (error) {
    const fallback = stale();
    if (fallback) return fallback;
    throw error;
  }
  if (response.status === 304 && saved) {
    await store({ ...saved, storedAtMs: Date.now() });
    return cachedResponse(saved);
  }
  // A rate limit or a server error says nothing about access, so it keeps
  // the entry, and its validators, for later reads.
  if (response.status === 429 || response.status >= 500) {
    const fallback = stale();
    if (fallback) {
      // Some bodies, such as one that egress streams, finish cancelling
      // only when their source does, so this does not wait.
      void response.body?.cancel().catch(() => undefined);
      return fallback;
    }
    return response;
  }
  if (response.status !== 200) {
    // An answer such as 403 or 404 must not let a later error serve the
    // entry to a credential that lost access.
    if (saved) await state.delete(key).catch(() => undefined);
    return response;
  }
  const body = Buffer.from(await response.arrayBuffer());
  const headers = Object.fromEntries(
    KEPT_HEADERS.flatMap((name) => {
      const value = response.headers.get(name);
      return value ? [[name, value]] : [];
    }),
  );
  const revalidates = Boolean(headers["etag"] || headers["last-modified"]);
  if (
    body.byteLength <= MAX_SAVED_BODY_BYTES &&
    (read.ttlMs > 0 || revalidates)
  ) {
    await store({
      body: body.toString("base64"),
      headers,
      storedAtMs: Date.now(),
    });
  }
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}
