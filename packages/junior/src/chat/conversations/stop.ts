import type { StateAdapter } from "chat";
import {
  cancelWaitingParentMessages,
  dropOwnUnreadLoopReplies,
  reportPersonStopToParent,
  stopChildAgentsBelow,
} from "@/chat/child-agents/stop";
import { stopConversationTree } from "@/chat/conversations/session-stop";
import type { ConversationStore } from "@/chat/conversations/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { InboundMessageClaim } from "@/chat/task-execution/state";
import {
  claimInboundMessage,
  ensureConversationWake,
  releaseInboundMessage,
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
 * Stop a Conversation for a person on every path; a Turn waiting for sign-in
 * ends too. A message or button stop claims its id first, so a redelivery gets
 * `duplicate`. Only a failure before the stop request is saved frees the claim.
 * Only person input sent by the stop's send time drops. Children and sessions
 * stop first, even with no Turn, so a failure leaves work to retry.
 */
export async function stopConversation(args: {
  conversationId: string;
  conversationStore?: ConversationStore | undefined;
  /** The message or button press that asked for the stop, if any. */
  message?: StopRequest | undefined;
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
    // The report goes first: a retry after a later step fails finds the
    // work that this stop cuts, and the report's key makes it send once.
    await reportPersonStopToParent(args.conversationId, {
      queue: args.queue,
      state: args.state,
      stoppedAtMs,
    });
    const result = await stopConversationAndChildAgents({
      conversationId: args.conversationId,
      conversationStore: args.conversationStore,
      nowMs,
      onStopSaved: () => {
        stopSaved = true;
      },
      queue: args.queue,
      sentAtOrBeforeMs: args.message ? stoppedAtMs : undefined,
      state: args.state,
      stoppedAtMs,
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

/**
 * Stop a Conversation and every child agent below it, for a person's stop and
 * the automated-turn limit. Children stop first, so a failure leaves the
 * Conversation running for a retry. Its waiting parent messages drop before
 * the stop request is saved, so no stop request outlives the stop.
 */
export async function stopConversationAndChildAgents(
  args: Omit<Parameters<typeof stopConversationTree>[1], "nowMs"> & {
    conversationId: string;
    nowMs: number;
  },
): Promise<StopConversationWorkResult> {
  const { conversationId, ...options } = args;
  await stopChildAgentsBelow(conversationId, {
    nowMs: options.nowMs,
    queue: options.queue,
    stoppedAtMs: options.stoppedAtMs,
    state: options.state,
  });
  await cancelWaitingParentMessages(conversationId, {
    nowMs: options.stoppedAtMs,
    state: options.state,
  });
  const [result] = await stopConversationTree([conversationId], options);
  if (!result) throw new Error("Stop returned no result");
  await dropOwnUnreadLoopReplies(conversationId, options.state);
  return result;
}
