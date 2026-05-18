import type { Adapter, Message } from "chat";
import {
  extractMessageChangedMention,
  isMessageChangedEnvelope,
} from "@/chat/ingress/message-changed";
import { runWithWorkspaceTeamId } from "@/chat/ingress/workspace-membership";
import { logException } from "@/chat/logging";
import { rehydrateAttachmentFetchers } from "@/chat/queue/thread-message-dispatcher";
import type { WaitUntilFn } from "@/handlers/types";

interface SlackWebhookAuthAdapter extends Adapter {
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

interface SlackWebhookBot {
  getAdapter(name: "slack"): Adapter;
  initialize(): Promise<void>;
  processMessage(
    adapter: Adapter,
    threadId: string,
    message: Message,
    options: { waitUntil: (task: Promise<unknown>) => void },
  ): void;
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
  bot: SlackWebhookBot;
  rawBody: string;
  request: Request;
  waitUntil: WaitUntilFn;
}): Promise<void> {
  const slackAdapter = args.bot.getAdapter("slack");
  const authAdapter = slackAdapter as SlackWebhookAuthAdapter;
  const timestamp = args.request.headers.get("x-slack-request-timestamp");
  const signature = args.request.headers.get("x-slack-signature");

  // Reuse the adapter's own Slack signature verification before dispatching
  // the synthetic edit event so this side-channel cannot bypass auth.
  if (!authAdapter.verifySignature(args.rawBody, timestamp, signature)) {
    return;
  }

  // Chat SDK initializes adapters automatically inside webhook handling. This
  // side-channel runs before the SDK handler, so it must join that lifecycle.
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

/** Rebuild Slack webhook requests after inspecting body-owned side channels. */
export async function prepareSlackWebhookRequest(args: {
  bot: SlackWebhookBot;
  request: Request;
  waitUntil: WaitUntilFn;
}): Promise<{ request: Request; runWithWorkspace<T>(fn: () => T): T }> {
  const rawBody = await args.request.text();
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    parsedBody = undefined;
  }

  const teamId = getSlackPayloadTeamId(parsedBody);

  if (parsedBody && isMessageChangedEnvelope(parsedBody)) {
    try {
      await runWithWorkspaceTeamId(teamId, () =>
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
    runWithWorkspace: (fn) => runWithWorkspaceTeamId(teamId, fn),
  };
}
