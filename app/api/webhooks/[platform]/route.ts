import { after } from "next/server";
import { bot } from "@/chat/bot";
import { createRequestContext, logException, setSpanAttributes, setSpanStatus, withContext, withSpan } from "@/chat/observability";

type Platform = keyof typeof bot.webhooks;
type WebhookRouteContext = {
  params: Promise<{
    platform: string;
  }>;
};

export const runtime = "nodejs";

export async function POST(request: Request, context: WebhookRouteContext): Promise<Response> {
  const { platform } = await context.params;
  const handler = bot.webhooks[platform as Platform];
  const requestContext = createRequestContext(request, { platform });
  const requestUrl = new URL(request.url);

  return withContext(requestContext, async () => {
    if (!handler) {
      const error = new Error(`Unknown platform: ${platform}`);
      logException(error, "webhook_platform_unknown", {}, {
        "http.response.status_code": 404
      }, `Unknown platform: ${platform}`);
      return new Response(`Unknown platform: ${platform}`, { status: 404 });
    }

    try {
      return await withSpan(
        "http.server.request",
        "http.server",
        requestContext,
        async () => {
          try {
            const response = await handler(request, {
              waitUntil: (task) => after(() => task)
            });
            setSpanAttributes({
              "http.response.status_code": response.status
            });
            setSpanStatus(response.status >= 500 ? "error" : "ok");
            return response;
          } catch (error) {
            setSpanStatus("error");
            throw error;
          }
        },
        {
          "http.request.method": request.method,
          "url.path": requestUrl.pathname
        }
      );
    } catch (error) {
      logException(error, "webhook_handler_failed");
      throw error;
    }
  });
}
