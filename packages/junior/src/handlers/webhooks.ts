import type { SlackAdapter } from "@chat-adapter/slack";
import { JuniorChat } from "@/chat/ingress/junior-chat";
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

type ChatSdkBot = JuniorChat<{ slack: SlackAdapter }>;

type WebhookRunner = () => Promise<Response>;

function getSlackPayloadTeamId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const teamId = (body as Record<string, unknown>).team_id;
  return typeof teamId === "string" && teamId.length > 0 ? teamId : undefined;
}

async function handleChatSdkWebhook(args: {
  bot: ChatSdkBot;
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
    // Do not intercept message_changed events. Slack edits cannot create or
    // change a Conversation Message or Turn after the original event.
    const rawBody = await args.request.text();
    const parsedBody = parseJson(rawBody);
    slackWorkspaceTeamId = getSlackPayloadTeamId(parsedBody);

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

/** Run a platform webhook with shared request tracing and error logging. */
export async function handleWebhookRequest(
  request: Request,
  platform: string,
  run: WebhookRunner,
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
            const response = await run();

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
              logWarn("webhook.response.unsuccessful", {
                "http.response.status_code": response.status,
                "http.request.header.x_slack_signature":
                  request.headers.get("x-slack-signature") ?? undefined,
                "http.request.header.x_slack_request_timestamp":
                  request.headers.get("x-slack-request-timestamp") ?? undefined,
                ...(responseBodySnippet
                  ? { "app.webhook.response_body": responseBodySnippet }
                  : undefined),
              });
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
      logException(error, "webhook.handler.failed");
      throw error;
    }
  });
}

/** Handle a Chat SDK webhook fixture through the shared webhook wrapper. */
export async function handleChatSdkPlatformWebhook(
  request: Request,
  platform: string,
  waitUntil: WaitUntilFn,
  chat: ChatSdkBot,
): Promise<Response> {
  return handleWebhookRequest(request, platform, () =>
    handleChatSdkWebhook({
      bot: chat,
      platform,
      request,
      waitUntil,
    }),
  );
}
