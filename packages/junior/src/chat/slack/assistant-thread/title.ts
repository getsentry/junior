import type { SlackAdapter } from "@chat-adapter/slack";
import { logError, logWarn, setSpanAttributes } from "@/chat/logging";
import {
  getSlackApiErrorCode,
  isSlackTitlePermissionError,
} from "@/chat/slack/errors";
import { isDmChannel } from "@/chat/slack/client";

/**
 * Best-effort Slack projection for a stored conversation title.
 *
 * Only DM assistant threads support `setAssistantTitle`. Channel conversations
 * keep the title in Junior for dashboard reporting and do not call Slack.
 */
export async function maybeSyncAssistantTitle(args: {
  channelId?: string;
  getSlackAdapter: () => Pick<SlackAdapter, "setAssistantTitle">;
  threadTs?: string;
  title: string;
}): Promise<void> {
  const channelId = args.channelId;
  const threadTs = args.threadTs;
  if (!channelId || !threadTs || !isDmChannel(channelId)) {
    return;
  }

  try {
    await args.getSlackAdapter().setAssistantTitle(channelId, threadTs, args.title);
  } catch (error) {
    const slackErrorCode = getSlackApiErrorCode(error);
    if (isSlackTitlePermissionError(error)) {
      const assistantTitleErrorAttributes = {
        "app.slack.assistant_title.outcome": "permission_denied",
        ...(slackErrorCode
          ? {
              "app.slack.assistant_title.error_code": slackErrorCode,
            }
          : {}),
      };
      setSpanAttributes(assistantTitleErrorAttributes);
      logError(
        "thread.title.generation_permission.denied",
        assistantTitleErrorAttributes,
      );
      return;
    }
    logWarn("thread.title.slack_update.failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
  }
}
