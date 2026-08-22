import type { SlackAdapter } from "@chat-adapter/slack";
import { logError, logWarn, setSpanAttributes } from "@/chat/logging";
import {
  getSlackApiErrorCode,
  isSlackTitlePermissionError,
} from "@/chat/slack/errors";
import { isDmChannel } from "@/chat/slack/client";

/** Set-once DM title projection for the current process. */
const projectedAssistantTitles = new Set<string>();

function assistantTitleKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

/** Test-only: clear set-once DM title projection between cases. */
export function resetAssistantTitleProjectionForTests(): void {
  projectedAssistantTitles.clear();
}

/**
 * Best-effort Slack projection for a stored conversation title.
 *
 * Only DM assistant threads support `setAssistantTitle`. Channel conversations
 * keep the title in Junior for dashboard reporting and do not call Slack.
 * Projection is set-once per DM thread so later turns do not rewrite Slack.
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

  const key = assistantTitleKey(channelId, threadTs);
  if (projectedAssistantTitles.has(key)) {
    return;
  }
  projectedAssistantTitles.add(key);

  try {
    await args.getSlackAdapter().setAssistantTitle(channelId, threadTs, args.title);
  } catch (error) {
    // Allow a later turn to retry after a transient failure. Stable permission
    // denials stay terminal for this process.
    const slackErrorCode = getSlackApiErrorCode(error);
    if (isSlackTitlePermissionError(error)) {
      const assistantTitleErrorAttributes = {
        "app.slack.assistant_title.outcome": "permission_denied",
        ...(slackErrorCode
          ? {
              "app.slack.assistant_title.error_code": slackErrorCode,
            }
          : undefined),
      };
      setSpanAttributes(assistantTitleErrorAttributes);
      logError(
        "thread.title.generation_permission.denied",
        assistantTitleErrorAttributes,
      );
      return;
    }
    projectedAssistantTitles.delete(key);
    logWarn("thread.title.slack_update.failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
  }
}
