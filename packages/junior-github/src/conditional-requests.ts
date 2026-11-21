/**
 * Conditional GitHub reads. GitHub does not count a `304 Not Modified`
 * answer against the rate limit, so a repeat read of an unchanged resource,
 * such as a pull request that every check suite webhook reads, is free.
 *
 * Saved bodies are plaintext in plugin state. A breach of that store exposes
 * up to 6 hours of webhook reads: pull requests, their commits with author
 * names and emails, reviews, and collaborator roles. It exposes no token.
 */
import { createHash } from "node:crypto";
import type { PluginState } from "@sentry/junior-plugin-api";
import * as z from "zod";

/**
 * How long a saved response stays. Webhooks for one pull request come in
 * bursts, such as one for each check suite, so most repeat reads are minutes
 * apart.
 */
const SAVED_RESPONSE_TTL_MS = 6 * 60 * 60_000;

/** Larger bodies, such as long commit lists, are not saved. */
const MAX_SAVED_BODY_LENGTH = 256 * 1024;

const savedResponseSchema = z.object({
  body: z.string(),
  etag: z.string().min(1),
});

/**
 * The state key of a saved response. It has no token: GitHub answers 304
 * only to a request that it authorized, and only when the response to that
 * request did not change, so a saved body never reaches a token that cannot
 * read it.
 */
function savedResponseKey(url: string): string {
  return `github-response:${createHash("sha256").update(url).digest("hex")}`;
}

/**
 * Send one GitHub GET with the ETag of its saved response. On 304, return
 * the saved body as a 200 response. On a 200 with an ETag, save the body.
 * Without `responses`, send the request as it is.
 */
export async function sendConditionalRequest(
  responses: PluginState | undefined,
  url: string,
  send: (headers: Record<string, string>) => Promise<Response>,
): Promise<Response> {
  if (!responses) return await send({});
  const key = savedResponseKey(url);
  const saved = savedResponseSchema.safeParse(await responses.get(key));
  const response = await send(
    saved.success ? { "If-None-Match": saved.data.etag } : {},
  );
  if (response.status === 304 && saved.success) {
    await response.body?.cancel();
    return new Response(saved.data.body, {
      headers: { etag: saved.data.etag },
      status: 200,
    });
  }
  const etag = response.headers.get("etag");
  if (!response.ok || !etag) return response;
  const body = await response.text();
  if (body.length <= MAX_SAVED_BODY_LENGTH) {
    await responses.set(key, { body, etag }, SAVED_RESPONSE_TTL_MS);
  }
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}
