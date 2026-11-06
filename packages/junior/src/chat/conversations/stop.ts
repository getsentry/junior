import type { StateAdapter } from "chat";
import { stopChildAgentsBelow } from "@/chat/agent-invocations/stop";
import { markConversationsStopped } from "@/chat/conversations/session-stop";
import type { ConversationStore } from "@/chat/conversations/store";
import { getAuthPausedConversationTurnId } from "@/chat/task-execution/mailbox-turn";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  ensureConversationWake,
  getConversation,
  requestConversationWork,
  stopConversationWork,
  type StopConversationWorkResult,
} from "@/chat/task-execution/store";

/** Stop the current Conversation Turn and wake an idle resume when needed. */
export async function stopConversationTurn(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
  nowMs?: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
}): Promise<StopConversationWorkResult> {
  const nowMs = args.nowMs ?? Date.now();
  const stop = async (): Promise<StopConversationWorkResult> =>
    await stopConversationWork({
      conversationId: args.conversationId,
      conversationStore: args.conversationStore,
      nowMs,
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

/**
 * Stop a Conversation for a person, on every stop path. Every child agent
 * below it stops, then it and they are stopped Conversations until a person
 * sends input, and then its Turn stops. Their Watch Events are saved and
 * start no Turn. Nothing above it changes: a stopped child agent's worker
 * reports the stop to its parent.
 *
 * The child agents and sessions stop first, so a failure leaves the Turn
 * running and the stop can be retried. A child agent can outlive the parent
 * Turn, so this runs even when no Turn runs. Known gap: `stopChildAgentsBelow`
 * names the gap for a child agent that the Turn spawns or messages before it
 * sees the stop.
 */
export async function stopConversation(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
}): Promise<StopConversationWorkResult> {
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
  return await stopConversationTurn(args);
}
