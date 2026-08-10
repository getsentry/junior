import type { SlackAdapter } from "@chat-adapter/slack";
import { logError, logWarn, setSpanAttributes } from "@/chat/logging";
import {
  getSlackApiErrorCode,
  isSlackTitlePermissionError,
} from "@/chat/slack/errors";
import {
  getThreadTitleSourceMessage,
  type ConversationMemoryService,
} from "@/chat/services/conversation-memory";
import { isDmChannel } from "@/chat/slack/client";
import type { ThreadConversationState } from "@/chat/state/conversation";

/**
 * Best-effort conversation title generation for all Slack conversations.
 *
 * Title generation is intentionally detached from reply generation and visible
 * reply delivery. For DM assistant threads the generated title is also pushed
 * to Slack via `setAssistantTitle`. For channel conversations the title is
 * generated and returned for dashboard reporting only — the Slack API for
 * setting thread titles is DM-only and is not called.
 *
 * Stable Slack permission failures on DM title updates are treated as a
 * terminal skip for the current source message so later turns do not keep
 * paying for the same fast-model call that Slack will reject.
 */
export function maybeUpdateAssistantTitle(args: {
  assistantThreadContext?: {
    channelId: string;
    threadTs: string;
  };
  assistantUserName: string;
  channelId?: string;
  conversation: ThreadConversationState;
  generateThreadTitle: ConversationMemoryService["generateThreadTitle"];
  getSlackAdapter: () => Pick<SlackAdapter, "setAssistantTitle">;
  modelId: string;
  actorId?: string;
  runId?: string;
  threadId?: string;
}): Promise<{ title?: string } | undefined> {
  const assistantThreadContext = args.assistantThreadContext;
  if (!assistantThreadContext?.channelId || !assistantThreadContext.threadTs) {
    return Promise.resolve(undefined);
  }

  const titleSourceMessage = getThreadTitleSourceMessage(args.conversation);
  if (!titleSourceMessage) {
    return Promise.resolve(undefined);
  }
  const isDm = isDmChannel(assistantThreadContext.channelId);

  return (async () => {
    let title: string | undefined;
    try {
      title = await args.generateThreadTitle(titleSourceMessage.text);
    } catch (error) {
      logWarn("thread.title.generation.failed", {
        "exception.message":
          error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }

    // Only DM assistant threads support the Slack setAssistantTitle API.
    if (isDm) {
      try {
        await args
          .getSlackAdapter()
          .setAssistantTitle(
            assistantThreadContext.channelId,
            assistantThreadContext.threadTs,
            title,
          );
      } catch (error) {
        const slackErrorCode = getSlackApiErrorCode(error);
        const assistantTitleErrorAttributes = {
          "app.slack.assistant_title.outcome": "permission_denied",
          ...(slackErrorCode
            ? {
                "app.slack.assistant_title.error_code": slackErrorCode,
              }
            : {}),
        };
        if (isSlackTitlePermissionError(error)) {
          // Persist the source message id so later turns do not keep paying
          // for another fast-model call that Slack will reject. The generated
          // title is still returned for dashboard reporting.
          setSpanAttributes(assistantTitleErrorAttributes);
          logError(
            "thread.title.generation_permission.denied",
            assistantTitleErrorAttributes,
          );
        } else {
          logWarn("thread.title.slack_update.failed", {
            "exception.message":
              error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return { title };
  })();
}
