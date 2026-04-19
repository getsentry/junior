import type { SlackAdapter } from "@chat-adapter/slack";
import { logWarn } from "@/chat/logging";
import {
  getSlackClient,
  normalizeSlackConversationId,
} from "@/chat/slack/client";

/**
 * Slack's assistant loading UI accepts both `status` and `loading_messages`,
 * but product policy keeps `status` stable and generic. User-visible progress
 * copy belongs in `loading_messages`.
 */
export const SLACK_ASSISTANT_ACTIVE_STATUS = "is working on your request...";

type AssistantStatusSender = (
  text: string,
  loadingMessages?: string[],
) => Promise<void>;

/**
 * Build a best-effort sender for Slack's assistant loading state.
 *
 * The `text` argument is internal progress copy. This transport maps it onto
 * Slack's loading surface and keeps the raw Slack `status` field fixed.
 */
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

  return async (text, loadingMessages) => {
    const channelId = args.channelId;
    const threadTs = args.threadTs;
    if (!channelId || !threadTs) {
      return;
    }

    const normalizedChannelId = normalizeSlackConversationId(channelId);
    if (!normalizedChannelId) {
      return;
    }

    const nextLoadingMessages = text ? (loadingMessages ?? [text]) : undefined;

    try {
      await runWithBoundSlackToken(adapter, boundToken, () =>
        adapter.setAssistantStatus(
          normalizedChannelId,
          threadTs,
          text ? SLACK_ASSISTANT_ACTIVE_STATUS : "",
          nextLoadingMessages,
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

/**
 * Build a best-effort sender for Slack's assistant loading state over raw Web
 * API calls. As with the adapter-backed path, the dynamic copy goes to
 * `loading_messages` while `status` stays fixed and generic.
 */
export function createSlackWebApiStatusSender(args: {
  channelId?: string;
  threadTs?: string;
  getSlackClient?: typeof getSlackClient;
}): AssistantStatusSender {
  const getClient = args.getSlackClient ?? getSlackClient;

  return async (text, loadingMessages) => {
    const channelId = args.channelId;
    const threadTs = args.threadTs;
    if (!channelId || !threadTs) {
      return;
    }

    const normalizedChannelId = normalizeSlackConversationId(channelId);
    if (!normalizedChannelId) {
      return;
    }

    const nextLoadingMessages = text ? (loadingMessages ?? [text]) : undefined;

    try {
      await getClient().assistant.threads.setStatus({
        channel_id: normalizedChannelId,
        thread_ts: threadTs,
        status: text ? SLACK_ASSISTANT_ACTIVE_STATUS : "",
        ...(nextLoadingMessages
          ? { loading_messages: nextLoadingMessages }
          : {}),
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
