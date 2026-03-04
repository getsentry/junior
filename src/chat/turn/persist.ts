import type { ThreadConversationState } from "@/chat/conversation-state";

export function markTurnCompleted(args: {
  conversation: ThreadConversationState;
  nowMs: number;
  updateConversationStats: (conversation: ThreadConversationState) => void;
}): void {
  args.conversation.processing.activeTurnId = undefined;
  args.conversation.processing.lastCompletedAtMs = args.nowMs;
  args.updateConversationStats(args.conversation);
}

export function markTurnFailed(args: {
  conversation: ThreadConversationState;
  nowMs: number;
  userMessageId?: string;
  markConversationMessage: (
    conversation: ThreadConversationState,
    messageId: string | undefined,
    patch: { replied?: boolean; skippedReason?: string }
  ) => void;
  updateConversationStats: (conversation: ThreadConversationState) => void;
}): void {
  args.conversation.processing.activeTurnId = undefined;
  args.conversation.processing.lastCompletedAtMs = args.nowMs;
  args.markConversationMessage(args.conversation, args.userMessageId, {
    replied: false,
    skippedReason: "reply failed"
  });
  args.updateConversationStats(args.conversation);
}
