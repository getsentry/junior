import { after } from "next/server";
import { bot } from "@/chat/bot";
import { createRequestContext, logException, withContext, withSpan } from "@/chat/observability";

type Platform = keyof typeof bot.webhooks;

export const runtime = "nodejs";

export async function POST(request: Request, context: RouteContext<"/api/webhooks/[platform]">): Promise<Response> {
  const { platform } = await context.params;
  const handler = bot.webhooks[platform as Platform];
  const requestContext = createRequestContext(request, { platform });
  const requestId = requestContext.requestId;

  return withContext(requestContext, async () => {
    if (!handler) {
      const error = new Error(`Unknown platform: ${platform}`);
      logException(error, "unknown webhook platform", {}, {
        "http.response.status_code": 404
      });
      return new Response(`Unknown platform: ${platform}`, { status: 404 });
    }

    try {
      return await withSpan(
        "webhook.handle",
        "webhook.handle",
        requestContext,
        () =>
          handler(request, {
            waitUntil: (task) => after(() => task)
          })
      );
    } catch (error) {
      logException(error, "webhook handler failed");
      throw error;
    }
  });
}
