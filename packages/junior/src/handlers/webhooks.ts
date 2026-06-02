import type { SlackAdapter } from "@chat-adapter/slack";
import { getProductionSlackWebhookServices } from "@/chat/app/production";
import { dispatchEventPromptRuns } from "@/chat/events/dispatch";
import { extractSlackChannelMessageCreatedEnvelope } from "@/chat/events/slack";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import {
  extractMessageChangedMention,
  isMessageChangedEnvelope,
} from "@/chat/ingress/message-changed";
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
import { rehydrateAttachmentFetchers } from "@/chat/queue/thread-message-dispatcher";
import type { WaitUntilFn } from "@/handlers/types";

interface SlackWebhookAuthAdapter {
  botUserId?: string;
  defaultBotTokenProvider?: () => string | Promise<string>;
  requestContext?: {
    run<T>(context: unknown, fn: () => T): T;
  };
  resolveTokenForTeam?: (
    installationId: string,
    isEnterpriseInstall?: boolean,
  ) => Promise<unknown>;
  verifySignature: (
    body: string,
    timestamp: string | null,
    signature: string | null,
  ) => boolean;
}

type LegacyChatSdkBot = JuniorChat<{ slack: SlackAdapter }>;

interface SlackPayloadInstallation {
  enterpriseId?: string;
  installationId: string;
  isEnterpriseInstall: boolean;
  workspaceTeamId?: string;
}

function stringPayloadField(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getSlackPayloadInstallation(
  body: unknown,
): SlackPayloadInstallation | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const record = body as Record<string, unknown>;
  const workspaceTeamId = stringPayloadField(record, "team_id");
  const enterpriseId = stringPayloadField(record, "enterprise_id");
  const isEnterpriseInstall = record.is_enterprise_install === true;
  const installationId = isEnterpriseInstall ? enterpriseId : workspaceTeamId;
  if (!installationId) {
    return undefined;
  }

  return {
    installationId,
    isEnterpriseInstall,
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(workspaceTeamId ? { workspaceTeamId } : {}),
  };
}

function getSlackPayloadTeamId(body: unknown): string | undefined {
  return getSlackPayloadInstallation(body)?.workspaceTeamId;
}

function withSlackInstallationContext(
  context: unknown,
  installation: SlackPayloadInstallation,
): unknown {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return context;
  }
  return {
    ...context,
    ...(installation.enterpriseId
      ? { enterpriseId: installation.enterpriseId }
      : {}),
    isEnterpriseInstall: installation.isEnterpriseInstall,
  };
}

async function runWithSlackPayloadInstallationContext<T>(args: {
  authAdapter: SlackWebhookAuthAdapter;
  body: unknown;
  callback: () => T | Promise<T>;
}): Promise<T | undefined> {
  if (args.authAdapter.defaultBotTokenProvider) {
    return await args.callback();
  }

  const installation = getSlackPayloadInstallation(args.body);
  if (
    !installation ||
    !args.authAdapter.resolveTokenForTeam ||
    !args.authAdapter.requestContext
  ) {
    return undefined;
  }

  const context = await args.authAdapter.resolveTokenForTeam(
    installation.installationId,
    installation.isEnterpriseInstall,
  );
  if (!context) {
    return undefined;
  }

  return await args.authAdapter.requestContext.run(
    withSlackInstallationContext(context, installation),
    args.callback,
  );
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

  await runWithSlackPayloadInstallationContext({
    authAdapter,
    body: args.body,
    callback: dispatch,
  });
}

async function handleAuthenticatedSlackEventPrompt(args: {
  body: unknown;
  bot: LegacyChatSdkBot;
  rawBody: string;
  request: Request;
}): Promise<void> {
  const slackAdapter = args.bot.getAdapter("slack");
  const authAdapter = slackAdapter as unknown as SlackWebhookAuthAdapter;
  const timestamp = args.request.headers.get("x-slack-request-timestamp");
  const signature = args.request.headers.get("x-slack-signature");

  if (!authAdapter.verifySignature(args.rawBody, timestamp, signature)) {
    return;
  }

  await args.bot.initialize();

  const dispatch = async () => {
    const botUserId = authAdapter.botUserId;
    if (!botUserId) {
      return;
    }

    const envelope = extractSlackChannelMessageCreatedEnvelope(args.body, {
      botUserId,
    });
    if (!envelope) {
      return;
    }

    await dispatchEventPromptRuns(envelope);
  };

  await runWithSlackPayloadInstallationContext({
    authAdapter,
    body: args.body,
    callback: dispatch,
  });
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

    if (parsedBody) {
      args.waitUntil(
        runWithWorkspaceTeamId(slackWorkspaceTeamId, async () => {
          try {
            await handleAuthenticatedSlackEventPrompt({
              body: parsedBody,
              bot: args.bot,
              rawBody,
              request: args.request,
            });
          } catch (error) {
            logException(error, "slack_event_prompt_dispatch_failed");
          }
        }),
      );
    }

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
 */
export async function handlePlatformWebhook(
  request: Request,
  platform: string,
  waitUntil: WaitUntilFn,
  legacyBot?: LegacyChatSdkBot,
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
