import { getProductionSlackWebhookServices } from "@/chat/app/production";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { runWithWorkspaceTeamId } from "@/chat/ingress/workspace-membership";
import {
  createRequestContext,
  logException,
  logWarn,
  setSpanAttributes,
  setSpanStatus,
  withContext,
  withSpan,
} from "@/chat/logging";
import {
  prepareLegacySlackWebhookRequest,
  type LegacySlackWebhookBot,
} from "@/handlers/webhooks/slack";
import type { WaitUntilFn } from "@/handlers/types";

async function handleLegacyChatSdkWebhook(args: {
  bot: LegacySlackWebhookBot;
  platform: string;
  request: Request;
  waitUntil: WaitUntilFn;
}): Promise<Response> {
  const handler =
    args.bot.webhooks[args.platform as keyof typeof args.bot.webhooks];
  if (!handler) {
    return new Response(`Unknown platform: ${args.platform}`, { status: 404 });
  }

  let request = args.request;
  let slackWorkspaceTeamId: string | undefined;
  if (args.platform === "slack") {
    const prepared = await prepareLegacySlackWebhookRequest({
      bot: args.bot,
      request,
      waitUntil: args.waitUntil,
    });
    request = prepared.request;
    slackWorkspaceTeamId = prepared.workspaceTeamId;
  }

  return await runWithWorkspaceTeamId(slackWorkspaceTeamId, () =>
    handler(request, {
      waitUntil: (task: Promise<unknown>) => args.waitUntil(task),
    } as Parameters<typeof handler>[1]),
  );
}

/**
 * Handles `POST /api/webhooks/:platform`.
 *
 * Slack production ingress persists messages into the durable conversation
 * mailbox and wakes the queue worker. The optional `legacyBot` parameter is
 * kept for integration tests that still exercise Chat SDK fixtures directly.
 */
export async function handlePlatformWebhook(
  request: Request,
  platform: string,
  waitUntil: WaitUntilFn,
  legacyBot?: LegacySlackWebhookBot,
): Promise<Response> {
  const requestContext = createRequestContext(request, { platform });
  const requestUrl = new URL(request.url);

  return await withContext(requestContext, async () => {
    try {
      return await withSpan(
        "http.server.request",
        "http.server",
        requestContext,
        async () => {
          try {
            let response: Response;
            if (legacyBot) {
              response = await handleLegacyChatSdkWebhook({
                bot: legacyBot,
                platform,
                request,
                waitUntil,
              });
            } else if (platform === "slack") {
              response = await handleSlackWebhook({
                request,
                services: getProductionSlackWebhookServices(),
                waitUntil,
              });
            } else {
              response = new Response(`Unknown platform: ${platform}`, {
                status: 404,
              });
            }

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

/** Handle a platform webhook request from the app route. */
export async function POST(
  request: Request,
  platform: string,
  waitUntil: WaitUntilFn,
): Promise<Response> {
  return handlePlatformWebhook(request, platform, waitUntil);
}
