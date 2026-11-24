import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { CONTENT_VERSION_HEADER } from "./schema/response";

/**
 * Hash a response body without its top-level `generatedAt`, the read time,
 * so two reads of unchanged content get the same token.
 */
export function contentVersion(body: unknown): string {
  const content = JSON.stringify(body, function (key, value: unknown) {
    return this === body && key === "generatedAt" ? undefined : value;
  });
  return createHash("sha256").update(content).digest("base64url");
}

/** Headers of a revalidated read. The content is the viewer's own. */
export function contentVersionHeaders(version: string) {
  return {
    "cache-control": "private, no-store",
    [CONTENT_VERSION_HEADER]: version,
  };
}

/**
 * Answer an unchanged JSON read with an empty 304, after the route built it.
 * This saves the download and the client parse, not the read, so a route
 * with a cheaper token, such as the detail version, sets its own. A response
 * that already carries `CONTENT_VERSION_HEADER` is left alone.
 */
export const revalidateContent: MiddlewareHandler = async (context, next) => {
  await next();
  const response = context.res;
  if (
    context.req.method !== "GET" ||
    response.status !== 200 ||
    response.headers.has(CONTENT_VERSION_HEADER) ||
    !response.headers.get("content-type")?.startsWith("application/json")
  ) {
    return;
  }
  const version = contentVersion(await response.clone().json());
  for (const [name, value] of Object.entries(contentVersionHeaders(version))) {
    context.header(name, value);
  }
  if (context.req.header(CONTENT_VERSION_HEADER) !== version) return;
  context.res = new Response(null, {
    headers: context.res.headers,
    status: 304,
  });
};

/**
 * Polled dashboard reads with no stored version token. The versions poll,
 * a detail change, or a running re-fill reads them again, and most reads
 * find them unchanged. The dashboard sends their tokens back.
 */
export const REVALIDATED_READ_PATHS = [
  "/api/cache-warming/savings/refill",
  "/api/conversations/:conversationId/agents",
  "/api/conversations/:conversationId/todos",
  "/api/conversations/:conversationId/watches",
  // The list. `/:id` also matches an item, `count`, and
  // `waiting-conversations`.
  "/api/inbox-items",
  "/api/inbox-items/:id",
  "/api/people/me/spend",
] as const;
