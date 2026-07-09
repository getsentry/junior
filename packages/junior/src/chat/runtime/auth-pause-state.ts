import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { markTurnClosed } from "@/chat/runtime/turn";
import { getTurnUserMessageId } from "@/chat/runtime/turn-user-message";
import {
  markConversationMessage,
  updateConversationStats,
} from "@/chat/services/conversation-memory";
import {
  coerceThreadConversationState,
  type ThreadConversationState,
} from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/visible-messages";

/** Mark an auth-paused turn complete after private authorization link delivery. */
export function completeAuthPauseTurn(args: {
  conversation: ThreadConversationState;
  sessionId: string;
}): void {
  markConversationMessage(
    args.conversation,
    getTurnUserMessageId(args.conversation, args.sessionId),
    {
      replied: true,
      skippedReason: undefined,
    },
  );
  markTurnClosed({
    conversation: args.conversation,
    nowMs: Date.now(),
    sessionId: args.sessionId,
    updateConversationStats,
  });
}

/** Reload thread state, mark the auth pause as parked, and persist it. */
export async function persistAuthPauseTurnState(args: {
  sessionId: string;
  threadStateId: string;
}): Promise<void> {
  const currentState = await getPersistedThreadState(args.threadStateId);
  const conversation = coerceThreadConversationState(currentState);
  await hydrateConversationMessages({
    conversation,
    conversationId: args.threadStateId,
  });
  completeAuthPauseTurn({
    conversation,
    sessionId: args.sessionId,
  });
  await persistThreadStateById(args.threadStateId, { conversation });
}
