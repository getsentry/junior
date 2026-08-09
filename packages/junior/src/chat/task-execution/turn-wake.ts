/**
 * Continue a paused turn via the conversation work queue.
 *
 * Wake-only: mailbox/lease own liveness; this just nudges the worker.
 */
import type { StateAdapter } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import type { ConversationStore } from "@/chat/conversations/store";
import {
  resolveTurnSessionRouting,
  type TurnSessionRouting,
} from "@/chat/services/turn-session-routing";
import {
  failTurnRecord,
  loadTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  ensureConversationWake,
  requestConversationWork,
} from "@/chat/task-execution/store";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";

export interface PausedTurnRequest {
  conversationId: string;
  destination: Destination;
  expectedVersion: number;
  turnId: string;
}

interface TurnWakeOptions {
  nowMs?: number;
  queue?: ConversationWorkQueue;
  state?: StateAdapter;
}

/** Build the worker input for a paused turn. */
export async function getPausedTurnRequest(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
  turnId: string;
}): Promise<PausedTurnRequest | undefined> {
  const checkpoint = await loadTurnCheckpoint({
    conversationId: args.conversationId,
    turnId: args.turnId,
  });
  const turn = checkpoint.record;
  if (
    !turn ||
    turn.state !== "paused" ||
    (turn.resumeReason !== "timeout" &&
      turn.resumeReason !== "yield" &&
      turn.resumeReason !== "retry") ||
    (turn.resumeReason === "timeout" && turn.sliceId < 2)
  ) {
    return undefined;
  }
  let routing: TurnSessionRouting;
  try {
    routing = await resolveTurnSessionRouting({
      conversationId: args.conversationId,
      conversationStore: args.conversationStore,
    });
  } catch (error) {
    await failTurnRecord({
      conversationId: args.conversationId,
      expectedVersion: turn.version,
      turnId: args.turnId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  return {
    conversationId: args.conversationId,
    destination: routing.destination,
    turnId: args.turnId,
    expectedVersion: turn.version,
  };
}

/** Wake the conversation worker for a paused turn. */
export async function wakePausedTurn(
  request: PausedTurnRequest,
  options: TurnWakeOptions = {},
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  await requestConversationWork({
    conversationId: request.conversationId,
    destination: request.destination,
    nowMs,
    state: options.state,
  });
  const queue = options.queue ?? getVercelConversationWorkQueue();
  await ensureConversationWake({
    conversationId: request.conversationId,
    idempotencyKey: [
      "agent-continue",
      request.conversationId,
      request.turnId,
      request.expectedVersion,
      nowMs,
    ].join(":"),
    nowMs,
    queue,
    state: options.state,
  });
}
