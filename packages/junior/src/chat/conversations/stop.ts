import type { StateAdapter } from "chat";
import { stopChildAgentsBelow } from "@/chat/agent-invocations/stop";
import { markConversationsStopped } from "@/chat/conversations/session-stop";
import type { ConversationStore } from "@/chat/conversations/store";
import { logException } from "@/chat/logging";
import { getAuthPausedConversationTurnId } from "@/chat/task-execution/mailbox-turn";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { InboundMessage } from "@/chat/task-execution/state";
import {
  claimInboundMessage,
  ensureConversationWake,
  getConversation,
  releaseInboundMessage,
  requestConversationWork,
  stopConversationWork,
  type StopConversationWorkResult,
} from "@/chat/task-execution/store";

/** Stop the current Conversation Turn and wake an idle resume when needed. */
export async function stopConversationTurn(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
  nowMs?: number;
  /** Runs once the stop request is saved. */
  onStopSaved?: () => void;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
}): Promise<StopConversationWorkResult> {
  const nowMs = args.nowMs ?? Date.now();
  const stop = async (): Promise<StopConversationWorkResult> =>
    await stopConversationWork({
      conversationId: args.conversationId,
      conversationStore: args.conversationStore,
      nowMs,
      onStopSaved: args.onStopSaved,
      state: args.state,
    });
  let result = await stop();

  if (
    result.status === "no_work" &&
    (await getAuthPausedConversationTurnId(args.conversationId))
  ) {
    const conversation = await getConversation({
      conversationId: args.conversationId,
      state: args.state,
    });
    await requestConversationWork({
      conversationId: args.conversationId,
      conversationStore: args.conversationStore,
      destination: conversation?.destination,
      nowMs,
      state: args.state,
    });
    result = await stop();
  }

  if (result.status === "requested") {
    await ensureConversationWake({
      conversationId: args.conversationId,
      conversationStore: args.conversationStore,
      idempotencyKey: `conversation-stop:${args.conversationId}:${result.runId}`,
      nowMs,
      queue: args.queue,
      replaceExistingWake: true,
      state: args.state,
    });
  }
  return result;
}

/** Result of a person's stop. A `duplicate` stop message changed nothing. */
export type StopConversationResult =
  | StopConversationWorkResult
  | { status: "duplicate" };

/**
 * Stop a Conversation for a person, on every stop path. Every child agent
 * below it stops, then it and they are stopped Conversations until a person
 * sends input, and then its Turn stops. Their Watch Events are saved and
 * start no Turn. Nothing above it changes: a stopped child agent's worker
 * reports the stop to its parent.
 *
 * A stop that comes from a message, such as the Slack `stop` keyword, passes
 * that message. Its id is claimed in the mailbox first, so a redelivery
 * returns `duplicate` and stops nothing, not even newer work. A stop that
 * fails before its stop request is saved releases its claim, so a redelivery
 * can stop again. A failure after that keeps the claim, as does a failed
 * reply: the work is already stopped, and a redelivery must not stop newer
 * work.
 *
 * The child agents and sessions stop first, so a failure leaves the Turn
 * running and the stop can be retried. A child agent can outlive the parent
 * Turn, so this runs even when no Turn runs.
 */
export async function stopConversation(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
  /** The message that asked for the stop, if any. */
  message?: InboundMessage;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
}): Promise<StopConversationResult> {
  if (
    args.message &&
    (
      await claimInboundMessage({
        conversationStore: args.conversationStore,
        message: args.message,
        state: args.state,
      })
    ).status === "duplicate"
  ) {
    return { status: "duplicate" };
  }
  let stopSaved = false;
  try {
    // One stop time for the whole tree, so a late cascade of a child agent
    // knows which Conversations this stop already reached.
    const nowMs = Date.now();
    await stopChildAgentsBelow(args.conversationId, {
      nowMs,
      state: args.state,
    });
    await markConversationsStopped([args.conversationId], {
      cancelWatches: false,
      nowMs,
      state: args.state,
    });
    return await stopConversationTurn({
      ...args,
      onStopSaved: () => {
        stopSaved = true;
      },
    });
  } catch (error) {
    if (args.message && !stopSaved) {
      // The stop error is the one that matters, so a failed release does not
      // replace it.
      await releaseInboundMessage({
        message: args.message,
        state: args.state,
      }).catch((releaseError: unknown) => {
        logException(releaseError, "conversation.stop.release.failed");
      });
    }
    throw error;
  }
}
