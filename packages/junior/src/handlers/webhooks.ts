import { getProductionBot } from "@/chat/app/production";
import {
  extractMessageChangedMention,
  isMessageChangedEnvelope,
} from "@/chat/ingress/message-changed";
import { rehydrateAttachmentFetchers } from "@/chat/queue/thread-message-dispatcher";
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
  defaultBotToken?: string;
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

function getSlackPayloadTeamId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const teamId = (body as Record<string, unknown>).team_id;
  return typeof teamId === "string" && teamId.length > 0 ? teamId : undefined;
}

async function handleAuthenticatedSlackMessageChangedMention(args: {
  body: unknown;
  bot: ReturnType<typeof getProductionBot>;
  rawBody: string;
  request: Request;
  waitUntil: WaitUntilFn;
}): Promise<void> {
  const slackAdapter = args.bot.getAdapter("slack");
  const authAdapter = slackAdapter as unknown as SlackWebhookAuthAdapter;
  const timestamp = args.request.headers.get("x-slack-request-timestamp");
  const signature = args.request.headers.get("x-slack-signature");

  // Reuse the adapter's own Slack signature verification before dispatching
  // the synthetic edit event so this side-channel cannot bypass auth.
  if (!authAdapter.verifySignature(args.rawBody, timestamp, signature)) {
    return;
  }

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

  if (authAdapter.defaultBotToken) {
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
export async function handlePlatformWebhook(
  request: Request,
  platform: string,
  waitUntil: WaitUntilFn,
  bot = getProductionBot(),
): Promise<Response> {
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
      const rawBody = await request.text();
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = undefined;
      }

      if (parsedBody && isMessageChangedEnvelope(parsedBody)) {
        try {
          await handleAuthenticatedSlackMessageChangedMention({
            body: parsedBody,
            bot,
            rawBody,
            request,
            waitUntil,
          });
        } catch (error) {
          logException(error, "slack_message_changed_side_channel_failed");
        }
      }

      // Reconstruct the request so the adapter can read the body.
      rebuiltRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: rawBody,
      });
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

export async function POST(
  request: Request,
  platform: string,
  waitUntil: WaitUntilFn,
): Promise<Response> {
  return handlePlatformWebhook(request, platform, waitUntil);
}
