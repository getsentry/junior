import { after } from "next/server";
import * as Sentry from "@sentry/nextjs";
import {
  createRequestContext,
  logException,
  logWarn,
  setSpanAttributes,
  setSpanStatus,
  withContext,
  withSpan,
} from "@/chat/logging";

/**
 * Webhook route contract for `@sentry/junior`.
 *
 * We keep a dedicated `/api/webhooks/:platform` surface so each adapter owns its
 * protocol details (signature verification, challenge flows, retries) while this
 * handler remains a thin dispatcher.
 */
type WebhookRouteContext = {
  params: Promise<{
    platform: string;
  }>;
};

async function loadBot() {
  const { getProductionBot } = await import("@/chat/app/production");
  return getProductionBot();
}

/**
 * Handles `POST /api/webhooks/:platform`.
 *
 * The router only resolves the platform and delegates to the adapter webhook
 * implementation; request semantics stay owned by the adapter package.
 */
export async function POST(
  request: Request,
  context: WebhookRouteContext,
): Promise<Response> {
  const bot = await loadBot();
  const { platform } = await context.params;
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
              waitUntil: (task) =>
                after(() => {
                  const runTask = () => {
                    const taskOrFactory = task as
                      | Promise<unknown>
                      | (() => Promise<unknown>);
                    return typeof taskOrFactory === "function"
                      ? taskOrFactory()
                      : taskOrFactory;
                  };
                  if (activeSpan) {
                    return Sentry.withActiveSpan(activeSpan, runTask);
                  }
                  return runTask();
                }),
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
