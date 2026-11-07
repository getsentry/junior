import { deleteWebAuthorization } from "@/chat/conversations/web-authorization";
import { markTurnClosed } from "@/chat/runtime/turn";
import type { ThreadConversationState } from "@/chat/state/conversation";
import { abandonTurnRecord } from "@/chat/task-execution/checkpoint";
import { listActiveMailboxTurns } from "@/chat/task-execution/mailbox-turn";

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
  isStopped: () => boolean;
  keepTurnId: string;
}): Promise<boolean> {
  const pendingAuthorizationActorId =
    args.conversation.processing.pendingAuth?.actorId;
  const superseded = (await listActiveMailboxTurns(args.conversationId)).filter(
    (record) => record.turnId !== args.keepTurnId,
  );
  for (const stale of superseded) {
    if (args.isStopped()) {
      return false;
    }
    await abandonTurnRecord({
      conversationId: args.conversationId,
      turnId: stale.turnId,
      errorMessage: "Turn superseded by new input",
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
  const authParked = superseded.some(
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
