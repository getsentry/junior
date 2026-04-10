import { getProductionBot } from "@/chat/app/production";
import { dispatchMessageChangedMention } from "@/chat/ingress/message-changed";
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
            // For Slack webhooks, peek the body to handle message_changed events
            // before the adapter consumes the request. The adapter calls
            // request.text() internally, so we read and reconstruct the request
            // here to allow both paths to see the full body.
            let forwardRequest = request;
            if (platform === "slack") {
              const body = await request.text();
              // Try to dispatch message_changed edits that add a bot @mention.
              // This runs synchronously (fire-and-forget via waitUntil internally)
              // so it does not block the 200 OK response to Slack.
              try {
                const payload: unknown = JSON.parse(body);
                dispatchMessageChangedMention(payload, bot, {
                  waitUntil: (task: Promise<unknown>) => waitUntil(task),
                });
              } catch {
                // Non-JSON bodies (interactive payloads, slash commands) are not
                // message_changed events — let the adapter handle them normally.
              }
              // Reconstruct the request with the already-consumed body.
              forwardRequest = new Request(request.url, {
                method: request.method,
                headers: request.headers,
                body,
              });
            }

            const response = await handler(forwardRequest, {
              waitUntil: (task: Promise<unknown>) => waitUntil(task),
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
