import { createAgentInvocationFromLatest } from "@/chat/agent-invocations/create";
import { getLatestAgentInvocationForConversation } from "@/chat/agent-invocations/store";
import { enqueueAgentInvocation } from "@/chat/agent-invocations/work";
import {
  reviewItemChangeRecord,
  type ReviewItemChange,
} from "@/chat/review-items/messages";
import { loadReviewItemInput } from "@/chat/review-items/prompt-input";
import type { ReviewItem } from "@/chat/review-items/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getToolApproval } from "./log";
import { parseToolApprovalDedupeKey } from "./request";

/**
 * Give the approver's answer to the child agent that asked. Its item links
 * only to the root, so the root gets the answer as usual. The child gets a
 * Turn as the stored Actor with the stored credentials, which is the only
 * Run that can run the call. A dismiss starts no Turn: the call does not
 * run, and the child's next Turn declines it. A retry reuses the same agent
 * invocation.
 */
export async function deliverToolApprovalAnswer(args: {
  change: ReviewItemChange;
  item: ReviewItem;
  queue: ConversationWorkQueue;
}): Promise<void> {
  const { change, item } = args;
  const key = parseToolApprovalDedupeKey(item.dedupeKey);
  if (
    change.kind !== "submitted" ||
    !key ||
    key.conversationId === item.addedByConversationId
  ) {
    return;
  }
  const approval = await getToolApproval(key.conversationId, key.toolCallId);
  if (
    !approval ||
    approval.reviewItemId !== item.id ||
    approval.claimTurnId ||
    approval.end
  ) {
    return;
  }
  const latest = await getLatestAgentInvocationForConversation(
    key.conversationId,
  );
  if (!latest) return;
  const input = await loadReviewItemInput(reviewItemChangeRecord(item, change));
  if (!input) return;
  const invocation = await createAgentInvocationFromLatest({
    input,
    invocationId: `tool-approval:${item.id}`,
    latest,
    runAs: {
      actor: approval.actor,
      credentialContext: approval.credentialContext,
    },
  });
  await enqueueAgentInvocation(invocation, { queue: args.queue });
}
