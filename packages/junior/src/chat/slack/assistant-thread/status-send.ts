import type { SlackAdapter } from "@chat-adapter/slack";
import { logWarn } from "@/chat/logging";
import {
  getSlackClient,
  normalizeSlackConversationId,
} from "@/chat/slack/client";

export type AssistantStatusSender = (
  text: string,
  suggestions?: string[],
) => Promise<void>;

/** Build a best-effort status sender on top of the Slack adapter surface. */
export function createSlackAdapterStatusSender(args: {
  channelId?: string;
  threadTs?: string;
  getSlackAdapter: () => Pick<SlackAdapter, "setAssistantStatus">;
}): AssistantStatusSender {
  const adapter = args.getSlackAdapter() as Pick<
    SlackAdapter,
    "setAssistantStatus" | "withBotToken"
  > & {
    requestContext?: {
      getStore: () => { token?: string } | undefined;
    };
  };
  // Deferred timer callbacks may run after the adapter's ambient request
  // context is gone, so bind the active installation token up front.
  const boundToken = getSlackAdapterRequestToken(adapter);

  return async (text, suggestions) => {
    const channelId = args.channelId;
    const threadTs = args.threadTs;
    if (!channelId || !threadTs) {
      return;
    }

    const normalizedChannelId = normalizeSlackConversationId(channelId);
    if (!normalizedChannelId) {
      return;
    }

    try {
      await runWithBoundSlackToken(adapter, boundToken, () =>
        adapter.setAssistantStatus(
          normalizedChannelId,
          threadTs,
          text,
          suggestions,
        ),
      );
    } catch (error) {
      logAssistantStatusFailure({
        status: text,
        error,
        channelId,
        normalizedChannelId,
        threadTs,
      });
    }
  };
}

/** Build a best-effort status sender on top of direct Slack Web API calls. */
export function createSlackWebApiStatusSender(args: {
  channelId?: string;
  threadTs?: string;
  getSlackClient?: typeof getSlackClient;
}): AssistantStatusSender {
  const getClient = args.getSlackClient ?? getSlackClient;

  return async (text, suggestions) => {
    const channelId = args.channelId;
    const threadTs = args.threadTs;
    if (!channelId || !threadTs) {
      return;
    }

    const normalizedChannelId = normalizeSlackConversationId(channelId);
    if (!normalizedChannelId) {
      return;
    }

    try {
      await getClient().assistant.threads.setStatus({
        channel_id: normalizedChannelId,
        thread_ts: threadTs,
        status: text,
        ...(suggestions ? { loading_messages: suggestions } : {}),
      });
    } catch (error) {
      logAssistantStatusFailure({
        status: text,
        error,
        channelId,
        normalizedChannelId,
        threadTs,
      });
    }
  };
}

function getSlackAdapterRequestToken(adapter: {
  requestContext?: {
    getStore: () => { token?: string } | undefined;
  };
}): string | undefined {
  const token = adapter.requestContext?.getStore()?.token;
  if (typeof token !== "string") {
    return undefined;
  }
  const trimmed = token.trim();
  return trimmed || undefined;
}

async function runWithBoundSlackToken<T>(
  adapter: Pick<SlackAdapter, "withBotToken">,
  token: string | undefined,
  task: () => Promise<T>,
): Promise<T> {
  if (!token) {
    return await task();
  }
  return await adapter.withBotToken(token, task);
}

function logAssistantStatusFailure(args: {
  status: string;
  error: unknown;
  channelId: string;
  normalizedChannelId: string;
  threadTs: string;
}): void {
  logWarn(
    "assistant_status_update_failed",
    {},
    {
      "app.slack.status_text": args.status || "(clear)",
      "app.slack.channel_id_raw": args.channelId,
      "app.slack.channel_id": args.normalizedChannelId,
      "app.slack.thread_ts": args.threadTs,
      "error.message":
        args.error instanceof Error ? args.error.message : String(args.error),
    },
    `Failed to update assistant status channel=${args.normalizedChannelId} raw=${args.channelId} thread=${args.threadTs}`,
  );
}
