import * as Sentry from "@/chat/sentry";
import { getProductionBot } from "@/chat/app/production";
import {
  createRequestContext,
  logException,
  logWarn,
  setSpanAttributes,
  setSpanStatus,
  withContext,
  withSpan,
} from "@/chat/logging";
import type { WaitUntilFn } from "@/handlers/types";

/**
 * Handles `POST /api/webhooks/:platform`.
 *
 * The router only resolves the platform and delegates to the adapter webhook
 * implementation; request semantics stay owned by the adapter package.
 */
export async function POST(
  request: Request,
  platform: string,
  waitUntil: WaitUntilFn,
): Promise<Response> {
  const bot = getProductionBot();
  const handler = bot.webhooks[platform as keyof typeof bot.webhooks];
  const requestContext = createRequestContext(request, { platform });
  const requestUrl = new URL(request.url);

  return withContext(requestContext, async () => {
    if (!handler) {
      const error = new Error(`Unknown platform: ${platform}`);
      logException(
        error,
        "webhook_platform_unknown",
        {},
        {
          "http.response.status_code": 404,
        },
        `Unknown platform: ${platform}`,
      );
      return new Response(`Unknown platform: ${platform}`, { status: 404 });
    }

    try {
      return await withSpan(
        "http.server.request",
        "http.server",
        requestContext,
        async () => {
          try {
            const activeSpan = Sentry.getActiveSpan();
            const response = await handler(request, {
              waitUntil: (task: Promise<unknown>) =>
                waitUntil(
                  activeSpan
                    ? Sentry.withActiveSpan(activeSpan, () => task)
                    : task,
                ),
            } as Parameters<typeof handler>[1]);
            if (response.status >= 400) {
              let responseBodySnippet: string | undefined;
              try {
                responseBodySnippet = (await response.clone().text()).slice(
                  0,
                  300,
                );
              } catch {
                responseBodySnippet = undefined;
              }
              logWarn(
                "webhook_non_success_response",
                {},
                {
                  "http.response.status_code": response.status,
                  "http.request.header.x_slack_signature":
                    request.headers.get("x-slack-signature") ?? undefined,
                  "http.request.header.x_slack_request_timestamp":
                    request.headers.get("x-slack-request-timestamp") ??
                    undefined,
                  ...(responseBodySnippet
                    ? { "app.webhook.response_body": responseBodySnippet }
                    : {}),
                },
                `Webhook ${platform} returned ${response.status}`,
              );
            }
            setSpanAttributes({
              "http.response.status_code": response.status,
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
          "url.path": requestUrl.pathname,
        },
      );
    } catch (error) {
      logException(error, "webhook_handler_failed");
      throw error;
    }
  });
}
