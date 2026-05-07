import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { markTurnCompleted } from "@/chat/runtime/turn";
import { getTurnUserMessageId } from "@/chat/runtime/turn-user-message";
import {
  markConversationMessage,
  updateConversationStats,
} from "@/chat/services/conversation-memory";
import {
  coerceThreadConversationState,
  type ThreadConversationState,
} from "@/chat/state/conversation";

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
  markTurnCompleted({
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
  completeAuthPauseTurn({
    conversation,
    sessionId: args.sessionId,
  });
  await persistThreadStateById(args.threadStateId, { conversation });
}
