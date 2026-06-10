import type { SlackAdapter } from "@chat-adapter/slack";
import { getProductionSlackWebhookServices } from "@/chat/app/production";
import {
  handleSlackWebhook,
  type SlackWebhookServices,
} from "@/chat/ingress/slack-webhook";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import {
  extractMessageChangedMention,
  isMessageChangedEnvelope,
} from "@/chat/ingress/message-changed";
import { rehydrateAttachmentFetchers } from "@/chat/slack/attachment-fetchers";
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
import type { WaitUntilFn } from "@/handlers/types";

interface SlackWebhookAuthAdapter {
  botUserId?: string;
  defaultBotTokenProvider?: () => string | Promise<string>;
  requestContext?: {
    run<T>(context: unknown, fn: () => T): T;
  };
  resolveTokenForTeam?: (teamId: string) => Promise<unknown>;
  verifySignature: (
    body: string,
    timestamp: string | null,
    signature: string | null,
  ) => boolean;
}

type LegacyChatSdkBot = JuniorChat<{ slack: SlackAdapter }>;

function getSlackPayloadTeamId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const teamId = (body as Record<string, unknown>).team_id;
  return typeof teamId === "string" && teamId.length > 0 ? teamId : undefined;
}

async function handleAuthenticatedSlackMessageChangedMention(args: {
  body: unknown;
  bot: LegacyChatSdkBot;
  rawBody: string;
  request: Request;
  waitUntil: WaitUntilFn;
}): Promise<void> {
  const slackAdapter = args.bot.getAdapter("slack");
  const authAdapter = slackAdapter as unknown as SlackWebhookAuthAdapter;
  const timestamp = args.request.headers.get("x-slack-request-timestamp");
  const signature = args.request.headers.get("x-slack-signature");

  if (!authAdapter.verifySignature(args.rawBody, timestamp, signature)) {
    return;
  }

  await args.bot.initialize();

  const webhookOptions = {
    waitUntil: (task: Promise<unknown>) => args.waitUntil(task),
  };
  const dispatch = () => {
    const botUserId = authAdapter.botUserId;
    if (!botUserId) {
      return false;
    }

    const result = extractMessageChangedMention(
      args.body,
      botUserId,
      slackAdapter,
    );
    if (!result) {
      return false;
    }

    rehydrateAttachmentFetchers(result.message);
    args.bot.processMessage(
      slackAdapter,
      result.threadId,
      result.message,
      webhookOptions,
    );
    return true;
  };

  if (authAdapter.defaultBotTokenProvider) {
    dispatch();
    return;
  }

  const teamId = getSlackPayloadTeamId(args.body);
  if (
    !teamId ||
    !authAdapter.resolveTokenForTeam ||
    !authAdapter.requestContext
  ) {
    return;
  }

  const context = await authAdapter.resolveTokenForTeam(teamId);
  if (!context) {
    return;
  }

  authAdapter.requestContext.run(context, dispatch);
}

async function handleLegacyChatSdkWebhook(args: {
  bot: LegacyChatSdkBot;
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
    const rawBody = await args.request.text();
    const parsedBody = parseJson(rawBody);
    slackWorkspaceTeamId = getSlackPayloadTeamId(parsedBody);

    if (parsedBody && isMessageChangedEnvelope(parsedBody)) {
      await runWithWorkspaceTeamId(slackWorkspaceTeamId, () =>
        handleAuthenticatedSlackMessageChangedMention({
          body: parsedBody,
          bot: args.bot,
          rawBody,
          request: args.request,
          waitUntil: args.waitUntil,
        }),
      );
    }

    request = new Request(args.request.url, {
      method: args.request.method,
      headers: args.request.headers,
      body: rawBody,
    });
  }

  return await runWithWorkspaceTeamId(slackWorkspaceTeamId, () =>
    handler(request, {
      waitUntil: (task: Promise<unknown>) => args.waitUntil(task),
    } as Parameters<typeof handler>[1]),
  );
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Handles `POST /api/webhooks/:platform`.
 *
 * Slack production ingress persists messages into the durable conversation
 * mailbox and wakes the queue worker. The optional `legacyBot` parameter is
 * kept for integration tests that still exercise Chat SDK fixtures directly.
 * The optional `services` parameter carries app-scoped runtime services.
 */
export async function handlePlatformWebhook(
  request: Request,
  platform: string,
  waitUntil: WaitUntilFn,
  legacyBot?: LegacyChatSdkBot,
  services?: SlackWebhookServices,
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
                services: services ?? getProductionSlackWebhookServices(),
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
  services?: SlackWebhookServices,
): Promise<Response> {
  return handlePlatformWebhook(
    request,
    platform,
    waitUntil,
    undefined,
    services,
  );
}
