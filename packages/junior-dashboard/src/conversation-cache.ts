import { createHash } from "node:crypto";
import { CONVERSATION_DETAIL_VERSION_HEADER } from "@sentry/junior/api/schema";
import type { MiddlewareHandler } from "hono";

/** Revalidate mock detail reads on content, after the route checks viewer access. */
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
  // has its own live watermark, so a poll that asks for it gets it alone.
  const { generatedAt: _generatedAt, mailbox, ...content } = report;
  const version = createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex");
  context.header("cache-control", "private, no-store");
  context.header(CONVERSATION_DETAIL_VERSION_HEADER, version);
  if (context.req.header(CONVERSATION_DETAIL_VERSION_HEADER) !== version)
    return;
  context.res = mailbox
    ? new Response(JSON.stringify({ mailbox, unchanged: true }), {
        headers: context.res.headers,
      })
    : new Response(null, { status: 304, headers: context.res.headers });
};
