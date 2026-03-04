import {
  createRequestContext,
  logException,
  logWarn,
  setSpanAttributes,
  setSpanStatus,
  withContext,
  withSpan
} from "./chunk-PZF6TC63.js";

// src/handlers/webhooks.ts
import { after } from "next/server";
import * as Sentry from "@sentry/nextjs";
async function loadBot() {
  const { bot } = await import("./bot-YQLHURDR.js");
  return bot;
}
async function POST(request, context) {
  const bot = await loadBot();
  const { platform } = await context.params;
  const handler = bot.webhooks[platform];
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
            const activeSpan = Sentry.getActiveSpan();
            const response = await handler(request, {
              waitUntil: (task) => after(() => {
                const runTask = () => {
                  const taskOrFactory = task;
                  return typeof taskOrFactory === "function" ? taskOrFactory() : taskOrFactory;
                };
                if (activeSpan) {
                  return Sentry.withActiveSpan(activeSpan, runTask);
                }
                return runTask();
              })
            });
            if (response.status >= 400) {
              let responseBodySnippet;
              try {
                responseBodySnippet = (await response.clone().text()).slice(0, 300);
              } catch {
                responseBodySnippet = void 0;
              }
              logWarn(
                "webhook_non_success_response",
                {},
                {
                  "http.response.status_code": response.status,
                  "http.request.header.x_slack_signature": request.headers.get("x-slack-signature") ?? void 0,
                  "http.request.header.x_slack_request_timestamp": request.headers.get("x-slack-request-timestamp") ?? void 0,
                  ...responseBodySnippet ? { "app.webhook.response_body": responseBodySnippet } : {}
                },
                `Webhook ${platform} returned ${response.status}`
              );
            }
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

export {
  POST
};
