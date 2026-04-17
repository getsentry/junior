import type { SlackAdapter } from "@chat-adapter/slack";
import { logError, logWarn, setSpanAttributes } from "@/chat/logging";
import {
  getSlackApiErrorCode,
  isSlackTitlePermissionError,
} from "@/chat/runtime/thread-context";
import {
  getThreadTitleSourceMessage,
  type ConversationMemoryService,
} from "@/chat/services/conversation-memory";
import { isDmChannel } from "@/chat/slack/client";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type { ThreadConversationState } from "@/chat/state/conversation";

/**
 * Best-effort assistant-thread title update for DM assistant threads.
 *
 * Title generation is intentionally detached from reply generation and visible
 * reply delivery. Stable Slack permission failures are treated as a terminal
 * skip for the current source message so later turns do not keep paying for
 * the same fast-model title generation call.
 */
export function maybeUpdateAssistantTitle(args: {
  assistantThreadContext?: {
    channelId: string;
    threadTs: string;
  };
  assistantUserName: string;
  artifacts: ThreadArtifactsState;
  channelId?: string;
  conversation: ThreadConversationState;
  generateThreadTitle: ConversationMemoryService["generateThreadTitle"];
  getSlackAdapter: () => Pick<SlackAdapter, "setAssistantTitle">;
  modelId: string;
  requesterId?: string;
  runId?: string;
  threadId?: string;
}): Promise<string | undefined> {
  const assistantThreadContext = args.assistantThreadContext;
  if (
    !assistantThreadContext?.channelId ||
    !assistantThreadContext.threadTs ||
    !isDmChannel(assistantThreadContext.channelId)
  ) {
    return Promise.resolve(undefined);
  }

  const titleSourceMessage = getThreadTitleSourceMessage(args.conversation);
  if (!titleSourceMessage) {
    return Promise.resolve(undefined);
  }
  if (args.artifacts.assistantTitleSourceMessageId === titleSourceMessage.id) {
    return Promise.resolve(undefined);
  }

  return (async () => {
    try {
      const title = await args.generateThreadTitle(titleSourceMessage.text);
      await args
        .getSlackAdapter()
        .setAssistantTitle(
          assistantThreadContext.channelId,
          assistantThreadContext.threadTs,
          title,
        );
      return titleSourceMessage.id;
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
        // Persist the source message anyway so later turns do not keep paying
        // for another fast-model title generation call Slack will reject.
        setSpanAttributes(assistantTitleErrorAttributes);
        logError(
          "thread_title_generation_permission_denied",
          {
            slackThreadId: args.threadId,
            slackUserId: args.requesterId,
            slackChannelId: args.channelId,
            runId: args.runId,
            assistantUserName: args.assistantUserName,
            modelId: args.modelId,
          },
          assistantTitleErrorAttributes,
          "Skipping thread title update due to Slack permission error",
        );
        return titleSourceMessage.id;
      }
      logWarn(
        "thread_title_generation_failed",
        {
          slackThreadId: args.threadId,
          slackUserId: args.requesterId,
          slackChannelId: args.channelId,
          runId: args.runId,
          assistantUserName: args.assistantUserName,
          modelId: args.modelId,
        },
        {
          "error.message":
            error instanceof Error ? error.message : String(error),
        },
        "Thread title generation failed",
      );
      return undefined;
    }
  })();
}
