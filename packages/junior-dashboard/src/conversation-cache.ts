import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/** Revalidate dashboard detail reads only after the route checks viewer access. */
export const revalidateConversation: MiddlewareHandler = async (
  context,
  next,
) => {
  await next();
  if (context.req.method !== "GET" || context.res.status !== 200) return;

  const report = (await context.res.clone().json()) as Record<string, unknown>;
  // The same route pattern also matches /conversations/stats.
  if (typeof report.conversationId !== "string") return;
  // generatedAt is the read time, not a change to the Conversation. The mailbox
  // has its own live watermark and is never handled by this middleware.
  const { generatedAt: _generatedAt, ...content } = report;
  const etag = `W/"${createHash("sha256").update(JSON.stringify(content)).digest("hex")}"`;
  context.header("cache-control", "private, no-store");
  context.header("etag", etag);
  const validators = context.req.header("if-none-match")?.split(",");
  if (
    validators?.some(
      (value) => value.trim().replace(/^W\//, "") === etag.slice(2),
    )
  ) {
    context.res = new Response(null, {
      status: 304,
      headers: context.res.headers,
    });
  }
};
