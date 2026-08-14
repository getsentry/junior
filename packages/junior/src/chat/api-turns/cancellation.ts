/** App-scoped control for one active API Turn per Conversation. */
export interface ApiTurnCancellation {
  begin(conversationId: string): AbortSignal | undefined;
  cancel(conversationId: string): boolean;
  finish(conversationId: string, signal: AbortSignal): void;
  signal(conversationId: string): AbortSignal | undefined;
}

/** Create in-process cancellation state for active API Turns. */
export function createApiTurnCancellation(): ApiTurnCancellation {
  const active = new Map<string, AbortController>();

  return {
    begin(conversationId) {
      if (active.has(conversationId)) {
        return undefined;
      }
      const controller = new AbortController();
      active.set(conversationId, controller);
      return controller.signal;
    },
    cancel(conversationId) {
      const controller = active.get(conversationId);
      if (!controller) {
        return false;
      }
      controller.abort(new Error("API Turn cancelled"));
      return true;
    },
    finish(conversationId, signal) {
      const controller = active.get(conversationId);
      if (controller?.signal === signal) {
        active.delete(conversationId);
      }
    },
    signal(conversationId) {
      return active.get(conversationId)?.signal;
    },
  };
}

/** Close one cancelled API Turn without a failure reply or retry. */
export async function completeCancelledApiTurn(args: {
  acknowledge(): Promise<void>;
  actorId: string;
  cancellation?: ApiTurnCancellation;
  conversation: ThreadConversationState;
  conversationId: string;
  lifecycle: ConversationTurnLifecycle;
  sandboxRef?: SandboxRef;
  signal?: AbortSignal;
  turnId: string;
  userMessageId: string;
}): Promise<void> {
  await abandonTurnRecord({
    conversationId: args.conversationId,
    turnId: args.turnId,
    errorMessage: "API Turn cancelled",
  });
  clearPendingAuth(args.conversation, args.turnId);
  markConversationMessage(args.conversation, args.userMessageId, {
    replied: false,
    skippedReason: "turn cancelled",
  });
  markTurnClosed({
    conversation: args.conversation,
    nowMs: Date.now(),
    sessionId: args.turnId,
  });
  await deleteWebAuthorization({
    actorId: args.actorId,
    conversationId: args.conversationId,
  });
  await persistThreadStateById(args.conversationId, {
    conversation: args.conversation,
    sandboxRef: args.sandboxRef,
  });
  await args.lifecycle.complete({
    conversationId: args.conversationId,
    createdAtMs: Date.now(),
    outcome: "cancelled",
    turnId: args.turnId,
  });
  if (args.signal) {
    args.cancellation?.finish(args.conversationId, args.signal);
  }
  await args.acknowledge();
}
import type { ConversationTurnLifecycle } from "@/chat/conversations/turn-lifecycle";
import { deleteWebAuthorization } from "@/chat/api-turns/authorization";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { markTurnClosed } from "@/chat/runtime/turn";
import type { SandboxRef } from "@/chat/sandbox/ref";
import { markConversationMessage } from "@/chat/services/conversation-memory";
import { clearPendingAuth } from "@/chat/services/pending-auth";
import type { ThreadConversationState } from "@/chat/state/conversation";
import { abandonTurnRecord } from "@/chat/task-execution/checkpoint";
