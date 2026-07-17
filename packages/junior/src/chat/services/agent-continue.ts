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
  activateAgentTurnAuthorizationRecovery,
  getAgentTurnSessionRecord,
  isAgentTurnAuthorizationRecoveryActive,
  listAgentTurnSessionSummaries,
  prepareAgentTurnAuthorizationRecovery,
  type AgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import { getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { getMcpStoredOAuthCredentials } from "@/chat/mcp/auth-store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  ensureConversationWake,
  requestConversationWork,
} from "@/chat/task-execution/store";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { sleep } from "@/chat/sleep";

const AUTHORIZATION_RECOVERY_LOCK_RETRY_MS = 250;

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

interface AuthorizationRecoveryIdentity {
  authorizationCompletionId: string;
  conversationId: string;
  expectedVersion: number;
  sessionId: string;
}

async function acquireAuthorizationRecoveryLock(
  conversationId: string,
): Promise<Awaited<ReturnType<typeof acquireActiveLock>>> {
  const state = getStateAdapter();
  const immediate = await acquireActiveLock(state, conversationId);
  if (immediate) return immediate;
  await sleep(AUTHORIZATION_RECOVERY_LOCK_RETRY_MS);
  return await acquireActiveLock(state, conversationId);
}

/** Prepare an auth recovery without racing a mailbox-owned terminal transition. */
export async function prepareAgentTurnAuthorizationRecoveryUnderActiveLock(
  args: Parameters<typeof prepareAgentTurnAuthorizationRecovery>[0],
): Promise<AgentTurnSessionRecord | undefined> {
  const state = getStateAdapter();
  await state.connect();
  const lock = await acquireAuthorizationRecoveryLock(args.conversationId);
  if (!lock) return undefined;
  try {
    return await prepareAgentTurnAuthorizationRecovery(args);
  } finally {
    await state.releaseLock(lock);
  }
}

/**
 * Activate an exact parked auth session and durably wake it under turn ownership.
 */
export async function activateAndScheduleAgentTurnAuthorizationRecovery(
  args: AuthorizationRecoveryIdentity,
  options: ScheduleAgentContinueOptions = {},
): Promise<AgentTurnSessionRecord | undefined> {
  const state = getStateAdapter();
  await state.connect();
  const lock = await acquireAuthorizationRecoveryLock(args.conversationId);
  if (!lock) return undefined;
  try {
    const current = await getAgentTurnSessionRecord(
      args.conversationId,
      args.sessionId,
    );
    if (
      !current ||
      current.state !== "awaiting_resume" ||
      current.resumeReason !== "auth" ||
      current.version !== args.expectedVersion ||
      current.authorizationRecovery?.authorizationCompletionId !==
        args.authorizationCompletionId
    ) {
      return undefined;
    }

    const activated = current.authorizationRecovery.active
      ? current
      : await activateAgentTurnAuthorizationRecovery(args);
    if (!activated?.destination) return undefined;
    await scheduleAgentContinue(
      {
        conversationId: activated.conversationId,
        destination: activated.destination,
        expectedVersion: activated.version,
        sessionId: activated.sessionId,
      },
      options,
    );
    return activated;
  } finally {
    await state.releaseLock(lock);
  }
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
    const recovery = sessionRecord.authorizationRecovery;
    if (!recovery?.active) return;
    await activateAndScheduleAgentTurnAuthorizationRecovery(
      {
        authorizationCompletionId: recovery.authorizationCompletionId,
        conversationId: sessionRecord.conversationId,
        expectedVersion: sessionRecord.version,
        sessionId: sessionRecord.sessionId,
      },
      options,
    );
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

/** Re-drive completed auth callbacks from indexed turn-session recovery state. */
export async function recoverAuthorizationCompletedAgentTurns(
  options: ScheduleAgentContinueOptions = {},
): Promise<number> {
  // Immediate callback scheduling is primary. The one-minute heartbeat repairs
  // from the existing operational feed, which retains the latest 5,000 writes.
  const recoveries = (await listAgentTurnSessionSummaries(5_000)).filter(
    (summary) =>
      summary.state === "awaiting_resume" &&
      summary.resumeReason === "auth" &&
      summary.authorizationRecovery,
  );
  let recovered = 0;
  for (const recoverySummary of recoveries) {
    try {
      const session = await getAgentTurnSessionRecord(
        recoverySummary.conversationId,
        recoverySummary.sessionId,
      );
      if (
        !session ||
        session.state !== "awaiting_resume" ||
        session.resumeReason !== "auth" ||
        !session.destination
      ) {
        continue;
      }
      const recovery = session.authorizationRecovery;
      if (!recovery) continue;
      if (!recovery.active) {
        const committed =
          recovery.authorizationKind === "plugin"
            ? await createUserTokenStore().hasAuthorizationCompletion(
                recovery.userId,
                recovery.provider,
                recovery.authorizationCompletionId,
              )
            : (
                await getMcpStoredOAuthCredentials(
                  recovery.userId,
                  recovery.provider,
                )
              )?.authorizationCompletionId ===
              recovery.authorizationCompletionId;
        if (!committed) continue;
      }
      const completed = await activateAndScheduleAgentTurnAuthorizationRecovery(
        {
          authorizationCompletionId: recovery.authorizationCompletionId,
          conversationId: recoverySummary.conversationId,
          expectedVersion: session.version,
          sessionId: recoverySummary.sessionId,
        },
        options,
      );
      if (!completed) continue;
      recovered += 1;
    } catch (error) {
      logException(
        error,
        "authorization_completed_resume_recovery_failed",
        { conversationId: recoverySummary.conversationId },
        { "app.ai.session_id": recoverySummary.sessionId },
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
    (await isAgentTurnAuthorizationRecoveryActive({
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
