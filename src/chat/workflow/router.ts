import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import { claimWorkflowStartupLease } from "@/chat/state";
import type { ThreadMessagePayload } from "@/chat/workflow/types";
import { slackThreadWorkflow, threadMessageHook } from "@/chat/workflow/thread-workflow";
import { logError, logInfo, logWarn, withContext } from "@/chat/observability";

const LEADER_POST_START_RESUME_DELAYS_MS = [250, 750, 1500] as const;
const FOLLOWER_RESUME_DELAYS_MS = [250, 750, 1500] as const;
const FINAL_SAFETY_RESUME_DELAYS_MS = [250, 500] as const;
const STARTUP_LEASE_TTL_MS = 3000;
const WARN_RETRY_ATTEMPT = 3;

type StartError = Error & { code?: string; name?: string };

interface ResumeAttemptResult {
  resumed: boolean;
  error?: unknown;
  runId?: string;
}

type StartupRole = "leader" | "follower";
type RetryPhase = "leader_post_start" | "follower_wait" | "final_safety_wait";

function getPayloadChannelId(payload: ThreadMessagePayload): string | undefined {
  return payload.thread.channelId;
}

function getPayloadUserId(payload: ThreadMessagePayload): string | undefined {
  return payload.message.author?.userId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyResumeMiss(error: unknown): "hook_not_found" | "resume_empty" | "resume_error" {
  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("not found")) {
    return "hook_not_found";
  }
  if (message.includes("returned no hook entity")) {
    return "resume_empty";
  }
  return "resume_error";
}

function isBenignStartRaceError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const typedError = error as StartError;
  const code = typedError.code?.toLowerCase();
  const name = typedError.name?.toLowerCase();
  const message = typedError.message.toLowerCase();

  if (code === "already_exists" || code === "conflict") {
    return true;
  }

  if (name === "conflicterror") {
    return true;
  }

  return (
    message.includes("already exists") ||
    message.includes("already started") ||
    message.includes("already running") ||
    message.includes("hook conflict") ||
    message.includes("duplicate")
  );
}

async function attemptResumeHook(
  normalizedThreadId: string,
  payload: ThreadMessagePayload
): Promise<ResumeAttemptResult> {
  try {
    const hook = await threadMessageHook.resume(normalizedThreadId, payload);
    if (hook) {
      return { resumed: true, runId: hook.runId };
    }

    return {
      resumed: false,
      error: new Error("Hook resume returned no hook entity")
    };
  } catch (error) {
    return {
      resumed: false,
      error
    };
  }
}

async function retryResume(
  normalizedThreadId: string,
  payload: ThreadMessagePayload,
  startupRole: StartupRole,
  retryDelaysMs: readonly number[],
  retryPhase: RetryPhase
): Promise<string | undefined> {
  let lastError: unknown;

  for (const [index, delayMs] of retryDelaysMs.entries()) {
    await sleep(delayMs);

    const resumeAttempt = await attemptResumeHook(normalizedThreadId, payload);
    if (resumeAttempt.resumed) {
      return resumeAttempt.runId;
    }

    lastError = resumeAttempt.error;
    const retryAttempt = index + 1;
    const retryReason = classifyResumeMiss(resumeAttempt.error);
    const isFinalRetry = index === retryDelaysMs.length - 1;
    const isWarnRetry = retryAttempt >= WARN_RETRY_ATTEMPT || isFinalRetry;
    const logRetry = isWarnRetry ? logWarn : logInfo;
    logRetry(
      "workflow_route_resume_retry",
      {},
      {
        "app.workflow.retry_attempt": retryAttempt,
        "app.workflow.retry_reason": retryReason,
        "app.workflow.retry_severity": isWarnRetry ? "warn" : "info",
        "app.workflow.startup_role": startupRole,
        "app.workflow.retry_phase": retryPhase,
        ...(retryReason !== "hook_not_found" ? { "error.message": getErrorMessage(resumeAttempt.error) } : {})
      },
      "Retrying workflow hook resume after startup race"
    );
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Failed to resume thread workflow hook after start");
}

async function startWorkflowAndRetryResume(args: {
  normalizedThreadId: string;
  payload: ThreadMessagePayload;
  startupLeaseOwnerToken: string;
  startupRole: StartupRole;
  resumeMissReason: ReturnType<typeof classifyResumeMiss>;
  resumeMissError?: unknown;
}): Promise<string | undefined> {
  const { normalizedThreadId, payload, startupLeaseOwnerToken, startupRole, resumeMissReason, resumeMissError } = args;
  let startedRunId: string | undefined;
  let startError: unknown;
  let startOutcome: "started" | "raced" | "failed" = "started";

  try {
    const startedRun = await start(slackThreadWorkflow, [normalizedThreadId, startupLeaseOwnerToken]);
    startedRunId = startedRun.runId;
  } catch (error) {
    if (isBenignStartRaceError(error)) {
      startError = error;
      startOutcome = "raced";
    } else {
      startError = error;
      startOutcome = "failed";
    }
  }

  logInfo(
    "workflow_route_start_attempt",
    {},
    {
      "app.workflow.message_kind": payload.kind,
      "app.workflow.startup_role": startupRole,
      "app.workflow.startup_lease": "acquired",
      ...(startedRunId ? { "app.workflow.run_id": startedRunId } : {}),
      "app.workflow.start_outcome": startOutcome,
      "app.workflow.resume_miss_reason": resumeMissReason,
      ...(resumeMissReason !== "hook_not_found" && resumeMissError
        ? { "error.message": getErrorMessage(resumeMissError) }
        : {}),
      ...(startError ? { "app.workflow.start_error": getErrorMessage(startError) } : {})
    },
    "Starting thread workflow after expected resume miss"
  );

  if (startOutcome === "failed") {
    throw startError;
  }

  const resumedRunId = await retryResume(
    normalizedThreadId,
    payload,
    startupRole,
    LEADER_POST_START_RESUME_DELAYS_MS,
    "leader_post_start"
  );
  return resumedRunId ?? startedRunId;
}

export async function routeToThreadWorkflow(
  normalizedThreadId: string,
  payload: ThreadMessagePayload
): Promise<string | undefined> {
  return withContext(
    {
      slackThreadId: normalizedThreadId,
      slackChannelId: getPayloadChannelId(payload),
      slackUserId: getPayloadUserId(payload)
    },
    async () => {
      const firstResumeAttempt = await attemptResumeHook(normalizedThreadId, payload);
      if (firstResumeAttempt.resumed) {
        return firstResumeAttempt.runId;
      }

      try {
        const firstMissReason = classifyResumeMiss(firstResumeAttempt.error);
        // Scenario A: This caller wins the per-thread startup lease and acts as the
        // leader that attempts to start the workflow and then resumes into its hook.
        const leaderOwnerToken = randomUUID();
        const claimedLeaderLease = await claimWorkflowStartupLease(
          normalizedThreadId,
          leaderOwnerToken,
          STARTUP_LEASE_TTL_MS
        );

        if (claimedLeaderLease) {
          return await startWorkflowAndRetryResume({
            normalizedThreadId,
            payload,
            startupLeaseOwnerToken: leaderOwnerToken,
            startupRole: "leader",
            resumeMissReason: firstMissReason,
            resumeMissError: firstResumeAttempt.error
          });
        }

        // Scenario B: Another caller already holds the startup lease and should be
        // creating the hook. This caller follows and waits with bounded resume polls.
        logInfo(
          "workflow_route_start_attempt",
          {},
          {
            "app.workflow.message_kind": payload.kind,
            "app.workflow.startup_role": "follower",
            "app.workflow.startup_lease": "contended",
            "app.workflow.start_outcome": "contended",
            "app.workflow.resume_miss_reason": firstMissReason
          },
          "Waiting for existing workflow startup lease holder"
        );

        try {
          return await retryResume(
            normalizedThreadId,
            payload,
            "follower",
            FOLLOWER_RESUME_DELAYS_MS,
            "follower_wait"
          );
        } catch (followerRetryError) {
          // Scenario C: Follower wait window expired without a resumable hook.
          // Try to become the new leader in case the original leader crashed/stalled.
          const fallbackOwnerToken = randomUUID();
          const claimedFallbackLease = await claimWorkflowStartupLease(
            normalizedThreadId,
            fallbackOwnerToken,
            STARTUP_LEASE_TTL_MS
          );
          if (claimedFallbackLease) {
            return await startWorkflowAndRetryResume({
              normalizedThreadId,
              payload,
              startupLeaseOwnerToken: fallbackOwnerToken,
              startupRole: "leader",
              resumeMissReason: classifyResumeMiss(followerRetryError),
              resumeMissError: followerRetryError
            });
          }

          // Scenario D: Fallback lease is also contended, meaning another caller is
          // actively handling startup. Do one final bounded resume window so this
          // payload is not dropped due to contention timing.
          return await retryResume(
            normalizedThreadId,
            payload,
            "follower",
            FINAL_SAFETY_RESUME_DELAYS_MS,
            "final_safety_wait"
          );
        }
      } catch (error) {
        // Scenario E: Terminal failure after all bounded start/resume windows.
        logError(
          "workflow_route_failed",
          {},
          {
            "app.workflow.message_kind": payload.kind,
            "error.message": error instanceof Error ? error.message : String(error)
          },
          "Failed to route message to thread workflow"
        );
        throw error;
      }
    }
  );
}
