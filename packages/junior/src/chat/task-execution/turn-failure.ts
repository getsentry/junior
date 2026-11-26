/** End a mailbox Turn that failed on its final attempt. */
import type { Actor } from "@sentry/junior-plugin-api";
import { indexEndedTurnEvents } from "@/chat/conversations/event-embedding";
import type { ConversationTurnFailureCode } from "@/chat/conversations/history";
import type { ConversationTurnLifecycle } from "@/chat/conversations/turn-lifecycle";
import { logException } from "@/chat/logging";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { markTurnFailed } from "@/chat/runtime/turn";
import type { SandboxRef } from "@/chat/sandbox/ref";
import { markConversationMessage } from "@/chat/services/conversation-memory";
import type { ThreadConversationState } from "@/chat/state/conversation";
import {
  failTurnRecord,
  getTurnRecord,
} from "@/chat/task-execution/checkpoint";

function captureConversationTurnFailure(args: {
  conversationId: string;
  error: unknown;
  failureCode: ConversationTurnFailureCode;
  runId?: string | undefined;
  turnId: string;
}): string | undefined {
  const eventId = logException(
    args.error,
    `conversation.turn.${args.failureCode}`,
    {
      conversationId: args.conversationId,
      ...(args.runId ? { runId: args.runId } : undefined),
      turnId: args.turnId,
    },
  );
  return typeof eventId === "string" ? eventId : undefined;
}

/**
 * Record a final-attempt failure on the Turn record, the Conversation, and
 * the Turn lifecycle, so the Turn ends failed and its update reaches the
 * starter and Watches. The caller still acknowledges the input.
 */
export async function failConversationTurn(args: {
  conversation: ThreadConversationState;
  conversationId: string;
  failure: unknown;
  failureCode: ConversationTurnFailureCode;
  lifecycle: ConversationTurnLifecycle;
  modelFailureCaptureAttempted: boolean;
  modelFailureEventId: string | undefined;
  reportAs: Actor;
  runId: string | undefined;
  /** The Sandbox that the Turn started with. */
  sandboxRef: SandboxRef | undefined;
  turnId: string;
  userMessageId: string;
}): Promise<void> {
  const {
    conversation,
    conversationId,
    failure,
    failureCode,
    runId,
    turnId,
    userMessageId,
  } = args;
  const failureEventId =
    args.modelFailureCaptureAttempted && failureCode === "agent_run_failed"
      ? args.modelFailureEventId
      : captureConversationTurnFailure({
          conversationId,
          error: failure,
          failureCode,
          runId,
          turnId,
        });
  // Fail the Turn record too, or a later wake with no new input
  // resumes this Turn as the open mailbox Turn (JUNIOR-9M). Its own
  // try so a lock timeout here still fails the Conversation copy.
  try {
    const latest = await getTurnRecord(conversationId, turnId);
    if (latest) {
      await failTurnRecord({
        conversationId,
        errorMessage:
          failure instanceof Error ? failure.message : String(failure),
        expectedVersion: latest.version,
        turnId,
      });
    }
  } catch (turnRecordError) {
    captureConversationTurnFailure({
      conversationId,
      error: turnRecordError,
      failureCode: "persistence_failed",
      runId,
      turnId,
    });
  }
  try {
    markTurnFailed({
      conversation,
      nowMs: Date.now(),
      sessionId: turnId,
      userMessageId,
      markConversationMessage,
    });
    await persistThreadStateById(conversationId, {
      conversation,
      sandboxRef: args.sandboxRef ?? null,
    });
  } catch (persistenceError) {
    captureConversationTurnFailure({
      conversationId,
      error: persistenceError,
      failureCode: "persistence_failed",
      runId,
      turnId,
    });
  }
  await args.lifecycle.fail({
    conversationId,
    createdAtMs: Date.now(),
    ...(failureEventId ? { eventId: failureEventId } : undefined),
    failureCode,
    failureText: failure instanceof Error ? failure.message : String(failure),
    reportAs: args.reportAs,
    turnId,
  });
  await indexEndedTurnEvents({ conversationId, turnId });
}
