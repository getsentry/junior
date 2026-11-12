import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { deleteWebAuthorization } from "@/chat/conversations/web-authorization";
import { getConversationEventStore } from "@/chat/db";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { markTurnClosed } from "@/chat/runtime/turn";
import {
  coerceThreadConversationState,
  type ThreadConversationState,
} from "@/chat/state/conversation";
import { canJoinTurn } from "@/chat/task-execution/attempt-selection";
import {
  abandonTurnRecord,
  getTurnRecord,
  type TurnRecord,
} from "@/chat/task-execution/checkpoint";
import { listActiveMailboxTurns } from "@/chat/task-execution/mailbox-turn";
import { getPausedTurnRequest } from "@/chat/task-execution/turn-wake";
import type { InboundMessage } from "@/chat/task-execution/store";

/**
 * End every open mailbox Turn other than `keepTurnId`, so new input runs in
 * the only open Turn. New input starts only when no yielded Turn waits, so an
 * open Turn here waits for OAuth or was left open by a failed or stopped Run.
 * The caller persists `conversation`. Returns false when `isStopped` turns
 * true first.
 */
export async function supersedeOpenMailboxTurns(args: {
  conversation: ThreadConversationState;
  conversationId: string;
  isStopped?: () => boolean;
  keepTurnId?: string;
}): Promise<boolean> {
  return await supersedeTurns({
    ...args,
    turns: (await listActiveMailboxTurns(args.conversationId)).filter(
      (record) => record.turnId !== args.keepTurnId,
    ),
  });
}

/**
 * End open Turns that new input replaces. A late resume or OAuth callback
 * for an ended Turn is a no-op. The caller persists `conversation`. Returns
 * false when `isStopped` turns true first.
 */
export async function supersedeTurns(args: {
  conversation: ThreadConversationState;
  conversationId: string;
  isStopped?: () => boolean;
  turns: readonly TurnRecord[];
}): Promise<boolean> {
  const pendingAuthorizationActorId =
    args.conversation.processing.pendingAuth?.actorId;
  for (const stale of args.turns) {
    if (args.isStopped?.()) {
      return false;
    }
    await abandonTurnRecord({
      conversationId: args.conversationId,
      turnId: stale.turnId,
      errorMessage: "Turn superseded by new input",
    });
    // The Turn ends without a reply, like a stopped Turn, so the
    // Conversation report does not show it as running.
    await new ConversationTurnLifecycleService(
      getConversationEventStore(),
    ).complete({
      conversationId: args.conversationId,
      createdAtMs: Date.now(),
      outcome: "cancelled",
      turnId: stale.turnId,
    });
    // Keep pendingAuth: MCP OAuth still needs it to accept an in-flight
    // connect and store credentials. The abandoned turn record makes a
    // late callback a resume no-op, matching Slack supersede behavior.
    markTurnClosed({
      conversation: args.conversation,
      nowMs: Date.now(),
      sessionId: stale.turnId,
    });
  }
  const authParked = args.turns.some(
    (record) => record.state === "paused" && record.resumeReason === "auth",
  );
  if (authParked && pendingAuthorizationActorId) {
    // Drop the dashboard connect prompt so a superseded OAuth flow
    // cannot leave a stale banner after the user moves on.
    await deleteWebAuthorization({
      actorId: pendingAuthorizationActorId,
      conversationId: args.conversationId,
    });
  }
  return true;
}

/**
 * End the Turn that waits for its next Run when `message` cannot join it, so
 * the message starts its own Turn instead of running with that Turn's Actor.
 * A stored legacy Turn without an Actor keeps taking the input.
 */
export async function supersedeTurnForInput(args: {
  conversationId: string;
  message: InboundMessage;
}): Promise<void> {
  const conversation = coerceThreadConversationState(
    await getPersistedThreadState(args.conversationId),
  );
  const turnId = conversation.processing.activeTurnId;
  if (
    !turnId ||
    !(await getPausedTurnRequest({
      conversationId: args.conversationId,
      turnId,
    }))
  ) {
    return;
  }
  const turn = await getTurnRecord(args.conversationId, turnId);
  if (!turn?.actor || canJoinTurn(turn, args.message)) return;
  await hydrateConversationMessages({
    conversation,
    conversationId: args.conversationId,
  });
  await supersedeTurns({
    conversation,
    conversationId: args.conversationId,
    turns: [turn],
  });
  await persistThreadStateById(args.conversationId, { conversation });
}
