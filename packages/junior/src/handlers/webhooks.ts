import { getProductionBot } from "@/chat/app/production";
import { getSlackBotUserId } from "@/chat/config";
import { handleMessageChangedMention } from "@/chat/ingress/message-changed";
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
 *
 * For Slack, the body is read once and used to detect `message_changed` events
 * that introduce a new bot @mention, which the Slack adapter silently ignores.
 * The request is then reconstructed so the adapter can consume it normally.
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

    // For Slack webhooks, peek the body to handle `message_changed` events
    // that introduce a new bot @mention. The Slack adapter drops these subtypes,
    // so we dispatch them as a synthesized mention before forwarding to the adapter.
    let rebuiltRequest = request;
    if (platform === "slack") {
      const botUserId = getSlackBotUserId();
      if (botUserId) {
        const rawBody = await request.text();
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = undefined;
        }

        if (parsedBody) {
          const slackAdapter = bot.getAdapter("slack");
          const webhookOptions = {
            waitUntil: (task: Promise<unknown>) => waitUntil(task),
          };
          handleMessageChangedMention(
            parsedBody,
            botUserId,
            slackAdapter,
            (adapter, threadId, message, opts) =>
              bot.processMessage(adapter, threadId, message, opts),
            webhookOptions,
          );
        }

        // Reconstruct the request so the adapter can read the body.
        rebuiltRequest = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: rawBody,
        });
      }
    }

    try {
      return await withSpan(
        "http.server.request",
        "http.server",
        requestContext,
        async () => {
          try {
            const response = await handler(rebuiltRequest, {
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
