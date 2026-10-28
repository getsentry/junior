import { botConfig } from "@/chat/config";
import { logWarn } from "@/chat/logging";
import {
  decideSubscribedThreadReply,
  type SubscribedDecisionInput,
} from "@/chat/services/subscribed-decision";

export interface SubscribedReplyPolicyDeps {
  completeDecision: Parameters<
    typeof decideSubscribedThreadReply
  >[0]["completeDecision"];
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
      modelId: botConfig.decisionModelId,
      input: args,
      completeDecision: deps.completeDecision,
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
      ...(decision.costUsd !== undefined
        ? { costUsd: decision.costUsd }
        : undefined),
      shouldReply: decision.shouldReply,
      shouldUnsubscribe: decision.shouldUnsubscribe,
      reason,
    };
  };
}
