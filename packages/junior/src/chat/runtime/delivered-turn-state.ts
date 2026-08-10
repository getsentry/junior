import type { AgentRunResult } from "@/chat/services/turn-result";
import type { ThreadConversationState } from "@/chat/state/conversation";
import type { ThreadStatePatch } from "@/chat/runtime/thread-state";
import { markTurnCompleted } from "@/chat/runtime/turn";
import { markConversationMessage } from "@/chat/services/conversation-memory";
import { clearPendingAuth } from "@/chat/services/pending-auth";

/** Build state after destination delivery or intentional no-reply completion. */
export function buildDeliveredTurnStatePatch(args: {
  conversation: ThreadConversationState;
  reply: AgentRunResult;
  sessionId: string;
  userMessageId?: string;
}): ThreadStatePatch & { conversation: ThreadConversationState } {
  const conversation = structuredClone(args.conversation);
  clearPendingAuth(conversation, args.sessionId);
  markConversationMessage(conversation, args.userMessageId, {
    replied: true,
    skippedReason: undefined,
  });
  markTurnCompleted({
    conversation,
    nowMs: Date.now(),
    sessionId: args.sessionId,
  });

  return {
    conversation,
    sandboxRef: args.reply.sandboxRef,
  };
}
