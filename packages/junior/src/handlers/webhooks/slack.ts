import type { SlackAdapter } from "@chat-adapter/slack";
import { dispatchEventPromptRuns } from "@/chat/events/dispatch";
import { extractSlackChannelMessageCreatedEnvelope } from "@/chat/events/slack";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import {
  extractMessageChangedMention,
  isMessageChangedEnvelope,
} from "@/chat/ingress/message-changed";
import { runWithWorkspaceTeamId } from "@/chat/ingress/workspace-membership";
import { logException } from "@/chat/logging";
import { rehydrateAttachmentFetchers } from "@/chat/queue/thread-message-dispatcher";
import type { WaitUntilFn } from "@/handlers/types";

export type LegacySlackWebhookBot = JuniorChat<{ slack: SlackAdapter }>;

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
  bot: LegacySlackWebhookBot;
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
  bot: LegacySlackWebhookBot;
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

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Prepare a legacy Chat SDK Slack webhook request after authenticated side channels.
 */
export async function prepareLegacySlackWebhookRequest(args: {
  bot: LegacySlackWebhookBot;
  request: Request;
  waitUntil: WaitUntilFn;
}): Promise<{ request: Request; workspaceTeamId?: string }> {
  const rawBody = await args.request.text();
  const parsedBody = parseJson(rawBody);
  const workspaceTeamId = getSlackPayloadTeamId(parsedBody);

  if (parsedBody) {
    args.waitUntil(
      runWithWorkspaceTeamId(workspaceTeamId, async () => {
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
    try {
      await runWithWorkspaceTeamId(workspaceTeamId, () =>
        handleAuthenticatedSlackMessageChangedMention({
          body: parsedBody,
          bot: args.bot,
          rawBody,
          request: args.request,
          waitUntil: args.waitUntil,
        }),
      );
    } catch (error) {
      logException(error, "slack_message_changed_side_channel_failed");
    }
  }

  return {
    request: new Request(args.request.url, {
      method: args.request.method,
      headers: args.request.headers,
      body: rawBody,
    }),
    ...(workspaceTeamId ? { workspaceTeamId } : {}),
  };
}
