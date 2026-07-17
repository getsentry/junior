/**
 * Durable agent continuation scheduling.
 *
 * This module owns the queue handoff used when an agent run pauses at a safe
 * Pi continuation boundary and needs another execution slice.
 */
import type { StateAdapter } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import { logException, logWarn } from "@/chat/logging";
import {
  getAgentTurnSessionRecord,
  hasAuthorizationCompletedAgentTurnCandidate,
  listAuthorizationCompletedAgentTurnCandidates,
  recordAuthorizationCompletedAgentTurnCandidate,
} from "@/chat/state/turn-session";
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

/** Mark an exact auth callback complete, then durably wake its paused session. */
export async function wakeAuthorizationCompletedAgentTurn(
  args: {
    conversationId: string;
    provider: string;
    sessionId: string;
  },
  options: ScheduleAgentContinueOptions = {},
): Promise<void> {
  try {
    const sessionRecord = await getAgentTurnSessionRecord(
      args.conversationId,
      args.sessionId,
    );
    if (!sessionRecord?.destination) {
      logWarn(
        "authorization_completed_resume_not_schedulable",
        { conversationId: args.conversationId },
        { "app.ai.session_id": args.sessionId },
        "Authorization callback found no durable session destination to wake",
      );
      return;
    }
    const resumable = await recordAuthorizationCompletedAgentTurnCandidate({
      conversationId: args.conversationId,
      expectedVersion: sessionRecord.version,
      sessionId: args.sessionId,
    });
    if (resumable?.destination) {
      await scheduleAgentContinue(
        {
          conversationId: resumable.conversationId,
          destination: resumable.destination,
          expectedVersion: resumable.version,
          sessionId: resumable.sessionId,
        },
        options,
      );
    }
  } catch (error) {
    logException(
      error,
      "authorization_completed_resume_schedule_failed",
      { conversationId: args.conversationId },
      {
        "app.ai.session_id": args.sessionId,
        "app.credential.provider": args.provider,
      },
      "Failed to schedule an authorized turn after its callback found the conversation busy",
    );
  }
}

/** Re-drive completed auth callbacks from their exact durable candidates. */
export async function recoverAuthorizationCompletedAgentTurns(
  options: ScheduleAgentContinueOptions = {},
): Promise<number> {
  const candidates = await listAuthorizationCompletedAgentTurnCandidates();
  let recovered = 0;
  for (const candidate of candidates) {
    if (recovered >= 25) break;
    try {
      const request = await getAwaitingAgentContinueRequest({
        conversationId: candidate.conversationId,
        sessionId: candidate.sessionId,
      });
      if (!request) continue;
      await scheduleAgentContinue(request, options);
      recovered += 1;
    } catch (error) {
      logException(
        error,
        "authorization_completed_resume_recovery_failed",
        { conversationId: candidate.conversationId },
        { "app.ai.session_id": candidate.sessionId },
        "Failed to recover an authorized turn awaiting a durable wake",
      );
    }
  }
  return recovered;
}

async function ensureAgentContinueWake(args: {
  nowMs: number;
  options: ScheduleAgentContinueOptions;
  request: AgentContinueRequest;
}): Promise<void> {
  const queue = args.options.queue ?? getVercelConversationWorkQueue();
  await ensureConversationWake({
    conversationId: args.request.conversationId,
    idempotencyKey: [
      "agent-continue",
      args.request.conversationId,
      args.request.sessionId,
      args.request.expectedVersion,
      args.nowMs,
    ].join(":"),
    nowMs: args.nowMs,
    queue,
    state: args.options.state,
  });
}

/** Build the queue request for an awaiting automatic agent continuation. */
export async function getAwaitingAgentContinueRequest(args: {
  conversationId: string;
  sessionId: string;
}): Promise<AgentContinueRequest | undefined> {
  const sessionRecord = await getAgentTurnSessionRecord(
    args.conversationId,
    args.sessionId,
  );
  if (!sessionRecord || sessionRecord.state !== "awaiting_resume") {
    return undefined;
  }
  const authorizationCompleted =
    sessionRecord.resumeReason === "auth" &&
    (await hasAuthorizationCompletedAgentTurnCandidate({
      conversationId: args.conversationId,
      expectedVersion: sessionRecord.version,
      sessionId: args.sessionId,
    }));
  if (
    (sessionRecord.resumeReason !== "timeout" &&
      sessionRecord.resumeReason !== "yield" &&
      !authorizationCompleted) ||
    (sessionRecord.resumeReason === "timeout" && sessionRecord.sliceId < 2)
  ) {
    return undefined;
  }
  if (!sessionRecord.destination) {
    return undefined;
  }

  return {
    conversationId: args.conversationId,
    destination: sessionRecord.destination,
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
  await ensureAgentContinueWake({
    nowMs,
    options,
    request,
  });
}
