import { botConfig } from "@/chat/config";
import { logWarn } from "@/chat/logging";
import {
  decideSubscribedThreadReply,
  type SubscribedDecisionInput,
} from "@/chat/services/subscribed-decision";
import type { completeObject } from "@/chat/pi/client";

export interface SubscribedReplyPolicyDeps {
  completeObject: typeof completeObject;
}

export interface SubscribedReplyDecision {
  reason: string;
  shouldReply: boolean;
  shouldUnsubscribe?: boolean;
}

export type SubscribedReplyPolicy = (
  args: SubscribedDecisionInput,
) => Promise<SubscribedReplyDecision>;

export function createSubscribedReplyPolicy(
  deps: SubscribedReplyPolicyDeps,
): SubscribedReplyPolicy {
  return async (args) => {
    const decision = await decideSubscribedThreadReply({
      botUserName: botConfig.userName,
      modelId: botConfig.fastModelId,
      input: args,
      completeObject: deps.completeObject,
      logClassifierFailure: (error, input) => {
        logWarn(
          "subscribed_message_classifier_failed",
          {
            slackThreadId: input.context.threadId,
            slackUserId: input.context.actorId,
            slackChannelId: input.context.channelId,
            runId: input.context.runId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.fastModelId,
          },
          {
            "exception.message":
              error instanceof Error ? error.message : String(error),
          },
          "Subscribed-message classifier failed; skipping reply",
        );
      },
    });

    const reason = decision.reasonDetail
      ? `${decision.reason}:${decision.reasonDetail}`
      : decision.reason;
    return {
      shouldReply: decision.shouldReply,
      shouldUnsubscribe: decision.shouldUnsubscribe,
      reason,
    };
  };
}
