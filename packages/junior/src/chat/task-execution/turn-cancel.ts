/**
 * End a cancelled Turn: a stop that a worker saw, or a stop of a Turn that
 * waits for sign-in with no worker.
 */
import { deleteWebAuthorization } from "@/chat/conversations/web-authorization";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { getConversationEventStore } from "@/chat/db";
import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { markTurnClosed } from "@/chat/runtime/turn";
import { getTurnUserMessage } from "@/chat/runtime/turn-user-message";
import { markConversationMessage } from "@/chat/services/conversation-memory";
import { clearPendingAuth } from "@/chat/services/pending-auth";
import {
  coerceThreadConversationState,
  type ThreadConversationState,
} from "@/chat/state/conversation";
import { abandonTurnRecord } from "@/chat/task-execution/checkpoint";
import { getAuthPausedConversationTurnId } from "@/chat/task-execution/mailbox-turn";
import type { SandboxRef } from "@/chat/sandbox/ref";

/** Close a cancelled Turn, save it, and acknowledge its input. */
export async function completeCancelledConversationTurn(args: {
  acknowledge(): Promise<void>;
  conversation: ThreadConversationState;
  conversationId: string;
  sandboxRef?: SandboxRef;
  turnId: string;
  userMessageId: string | undefined;
}): Promise<void> {
  const pendingAuthorization =
    args.conversation.processing.pendingAuth?.sessionId === args.turnId
      ? args.conversation.processing.pendingAuth
      : undefined;
  await abandonTurnRecord({
    conversationId: args.conversationId,
    turnId: args.turnId,
    errorMessage: "Turn cancelled",
  });
  clearPendingAuth(args.conversation, args.turnId);
  markConversationMessage(args.conversation, args.userMessageId, {
    replied: false,
    skippedReason: "turn cancelled",
  });
  markTurnClosed({
    conversation: args.conversation,
    sessionId: args.turnId,
  });
  if (pendingAuthorization) {
    await deleteWebAuthorization({
      actorId: pendingAuthorization.actorId,
      conversationId: args.conversationId,
    });
  }
  await persistThreadStateById(args.conversationId, {
    conversation: args.conversation,
    sandboxRef: args.sandboxRef,
  });
  await new ConversationTurnLifecycleService(
    getConversationEventStore(),
  ).complete({
    conversationId: args.conversationId,
    createdAtMs: Date.now(),
    outcome: "cancelled",
    turnId: args.turnId,
  });
  await args.acknowledge();
}

/**
 * End the Turn of a stopped Conversation that waits for sign-in, so a later
 * sign-in cannot resume it. A web Turn waits as an auth-paused Turn record. A
 * Slack request waits as the thread's pending sign-in. Every stop path calls
 * this, because no worker holds a waiting Turn and the stop wake can go to
 * queued input first.
 */
export async function cancelSignInWait(conversationId: string): Promise<void> {
  const turnId =
    (await getAuthPausedConversationTurnId(conversationId)) ??
    coerceThreadConversationState(await getPersistedThreadState(conversationId))
      .processing.pendingAuth?.sessionId;
  if (turnId) {
    await cancelSignInPausedTurn({ conversationId, turnId });
  }
}

/**
 * Cancel a Turn that waits for sign-in outside its worker, with the same
 * cleanup as a stopped resume.
 */
export async function cancelSignInPausedTurn(args: {
  conversationId: string;
  turnId: string;
}): Promise<void> {
  // Claim the Turn first. If a worker resumed it, the worker owns its end.
  const claimed = await abandonTurnRecord({
    conversationId: args.conversationId,
    errorMessage: "Turn cancelled",
    onlyIfAuthPaused: true,
    turnId: args.turnId,
  });
  if (!claimed) return;
  const conversation = coerceThreadConversationState(
    await getPersistedThreadState(args.conversationId),
  );
  await hydrateConversationMessages({
    conversation,
    conversationId: args.conversationId,
  });
  await completeCancelledConversationTurn({
    // No worker holds this Turn's input.
    acknowledge: async () => {},
    conversation,
    conversationId: args.conversationId,
    turnId: args.turnId,
    // A stranded Turn can lack its Message; the stop still ends the Turn.
    userMessageId: getTurnUserMessage(conversation, args.turnId)?.id,
  });
}
