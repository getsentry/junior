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
  costUsd?: number;
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
      logClassifierFailure: (error) => {
        logWarn("subscribed_message.classifier.failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
      },
    });

    const reason = decision.reasonDetail
      ? `${decision.reason}:${decision.reasonDetail}`
      : decision.reason;
    return {
      ...(decision.costUsd !== undefined ? { costUsd: decision.costUsd } : {}),
      shouldReply: decision.shouldReply,
      shouldUnsubscribe: decision.shouldUnsubscribe,
      reason,
    };
  };
}
