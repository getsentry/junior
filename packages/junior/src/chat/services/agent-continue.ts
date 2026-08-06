/**
 * Durable agent continuation scheduling.
 *
 * This module owns the queue handoff used when an agent run pauses at a safe
 * Pi continuation boundary and needs another execution slice.
 */
import type { StateAdapter } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import type { ConversationStore } from "@/chat/conversations/store";
import { resolveTurnSessionRouting } from "@/chat/services/turn-session-routing";
import { getAgentTurnSessionRecord } from "@/chat/state/turn-session";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  ensureConversationWake,
  requestConversationWork,
} from "@/chat/task-execution/store";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";

export interface AgentContinueRequest {
  conversationId: string;
  destination: Destination;
  expectedVersion: number;
  sessionId: string;
}

export interface ScheduleAgentContinueOptions {
  nowMs?: number;
  queue?: ConversationWorkQueue;
  state?: StateAdapter;
}

/** Build the queue request for an awaiting automatic agent continuation. */
export async function getAwaitingAgentContinueRequest(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
  sessionId: string;
}): Promise<AgentContinueRequest | undefined> {
  const sessionRecord = await getAgentTurnSessionRecord(
    args.conversationId,
    args.sessionId,
  );
  if (
    !sessionRecord ||
    sessionRecord.state !== "awaiting_resume" ||
    (sessionRecord.resumeReason !== "timeout" &&
      sessionRecord.resumeReason !== "yield" &&
      sessionRecord.resumeReason !== "retry") ||
    (sessionRecord.resumeReason === "timeout" && sessionRecord.sliceId < 2)
  ) {
    return undefined;
  }
  const routing = await resolveTurnSessionRouting({
    conversationId: args.conversationId,
    conversationStore: args.conversationStore,
  });
  if (!routing.destination) {
    return undefined;
  }

  return {
    conversationId: args.conversationId,
    destination: routing.destination,
    sessionId: args.sessionId,
    expectedVersion: sessionRecord.version,
  };
}

/** Schedule durable conversation work to continue a paused agent run. */
export async function scheduleAgentContinue(
  request: AgentContinueRequest,
  options: ScheduleAgentContinueOptions = {},
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
      request.sessionId,
      request.expectedVersion,
      nowMs,
    ].join(":"),
    nowMs,
    queue,
    state: options.state,
  });
}
