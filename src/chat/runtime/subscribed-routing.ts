import { botConfig } from "@/chat/config";
import { logWarn } from "@/chat/observability";
import { decideSubscribedThreadReply } from "@/chat/routing/subscribed-decision";
import { getBotDeps } from "@/chat/runtime/deps";

export async function shouldReplyInSubscribedThread(args: {
  rawText: string;
  text: string;
  conversationContext?: string;
  hasAttachments?: boolean;
  isExplicitMention?: boolean;
  context: {
    threadId?: string;
    requesterId?: string;
    channelId?: string;
    workflowRunId?: string;
  };
}): Promise<{ shouldReply: boolean; reason: string }> {
  const decision = await decideSubscribedThreadReply({
    botUserName: botConfig.userName,
    modelId: botConfig.fastModelId,
    input: args,
    completeObject: (input) => getBotDeps().completeObject(input),
    logClassifierFailure: (error, input) => {
      logWarn(
        "subscribed_reply_classifier_failed",
        {
          slackThreadId: input.context.threadId,
          slackUserId: input.context.requesterId,
          slackChannelId: input.context.channelId,
          workflowRunId: input.context.workflowRunId,
          assistantUserName: botConfig.userName,
          modelId: botConfig.fastModelId
        },
        {
          "error.message": error instanceof Error ? error.message : String(error)
        },
        "Subscribed-thread reply classifier failed; skipping reply"
      );
    }
  });

  const reason = decision.reasonDetail
    ? `${decision.reason}:${decision.reasonDetail}`
    : decision.reason;
  return {
    shouldReply: decision.shouldReply,
    reason
  };
}
