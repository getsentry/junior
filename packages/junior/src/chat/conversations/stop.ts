import type { StateAdapter } from "chat";
import { stopChildAgentsBelow } from "@/chat/agent-invocations/stop";
import { markConversationsStopped } from "@/chat/conversations/session-stop";
import type { ConversationStore } from "@/chat/conversations/store";
import { cancelSignInWait } from "@/chat/task-execution/turn-cancel";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { InboundMessageClaim } from "@/chat/task-execution/state";
import {
  claimInboundMessage,
  ensureConversationWake,
  releaseInboundMessage,
  stopConversationWork,
  type StopConversationWorkResult,
} from "@/chat/task-execution/store";

/**
 * The message or button press that asked for a stop. Its id dedupes
 * redeliveries, and the time it was sent is the stop time.
 */
export type StopRequest = InboundMessageClaim & { createdAtMs: number };

/** Result of a person's stop. A `duplicate` stop message changed nothing. */
export type StopConversationResult =
  | StopConversationWorkResult
  | { status: "duplicate" };

/**
 * Stop a Conversation for a person, on every stop path. Every child agent
 * below it stops, then it and they are stopped Conversations until a person
 * sends input, and then its Turn stops. A Turn that waits for sign-in ends
 * too, so a later sign-in does not resume it. Their Watch Events are saved
 * and start no Turn. Nothing above it changes: a stopped child agent's worker
 * reports the stop to its parent.
 *
 * A stop that comes from a message or a button press, such as the Slack
 * `stop` keyword or stop button, passes it. Its id is claimed in the mailbox
 * first, so a redelivery returns `duplicate` and stops nothing, not even
 * newer work. A stop that fails before its stop request is saved releases
 * its claim, so a redelivery can stop again. A failed claim check keeps a
 * claim that an earlier delivery saved. A failure after the stop request is
 * saved keeps the claim, as does a failed reply: the work is already
 * stopped, and a redelivery must not stop newer work. Its send time
 * is the stop time, and only person input sent at or before it is dropped.
 * So a retry writes the same stop and keeps input that the person sent after
 * it.
 *
 * The child agents and sessions stop first, so a failure leaves the Turn
 * running and the stop can be retried. A child agent can outlive the parent
 * Turn, so this runs even when no Turn runs.
 */
export async function stopConversation(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
  /** The message or button press that asked for the stop, if any. */
  message?: StopRequest;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
}): Promise<StopConversationResult> {
  // The claim stays outside the try. A failed claim leaves no claim of this
  // call, because the claim releases its own write when a later step fails.
  // So a redelivery whose claim check fails keeps the first delivery's claim.
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
    const stoppedAtMs = args.message?.createdAtMs ?? nowMs;
    await stopChildAgentsBelow(args.conversationId, {
      nowMs,
      stoppedAtMs,
      state: args.state,
    });
    await markConversationsStopped([args.conversationId], {
      cancelWatches: false,
      nowMs: stoppedAtMs,
      state: args.state,
    });
    await cancelSignInWait(args.conversationId);
    const result = await stopConversationWork({
      conversationId: args.conversationId,
      conversationStore: args.conversationStore,
      nowMs,
      onStopSaved: () => {
        stopSaved = true;
      },
      sentAtOrBeforeMs: args.message ? stoppedAtMs : undefined,
      state: args.state,
    });
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
  } catch (error) {
    if (args.message && !stopSaved) {
      await releaseInboundMessage({
        message: args.message,
        state: args.state,
      });
    }
    throw error;
  }
}
