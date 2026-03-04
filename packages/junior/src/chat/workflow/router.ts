import { start } from "workflow/api";
import type { ThreadMessagePayload } from "@/chat/workflow/types";
import { slackThreadWorkflow, threadMessageHook } from "@/chat/workflow/thread-workflow";

const LEADER_POST_START_RESUME_DELAYS_MS = [250, 750, 1500] as const;
const FOLLOWER_RESUME_DELAYS_MS = [250, 750, 1500] as const;
const FINAL_SAFETY_RESUME_DELAYS_MS = [250, 500] as const;
const STARTUP_LEASE_TTL_MS = 15000;
const WARN_RETRY_ATTEMPT = 3;

type StartError = Error & { code?: string; name?: string };

interface ResumeAttemptResult {
  resumed: boolean;
  error?: unknown;
  runId?: string;
}

type StartupRole = "leader" | "follower";
type RetryPhase = "leader_post_start" | "follower_wait" | "final_safety_wait";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createStartupLeaseToken(): string {
  return `lease-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function claimWorkflowStartupLeaseSafe(
  normalizedThreadId: string,
  ownerToken: string,
  ttlMs: number
): Promise<boolean> {
  const { claimWorkflowStartupLease } = await import("@/chat/state");
  return await claimWorkflowStartupLease(normalizedThreadId, ownerToken, ttlMs);
}

async function releaseWorkflowStartupLeaseSafe(normalizedThreadId: string, ownerToken: string): Promise<void> {
  const { releaseWorkflowStartupLease } = await import("@/chat/state");
  try {
    await releaseWorkflowStartupLease(normalizedThreadId, ownerToken);
  } catch {
    // Lease release is best effort and should not fail routing.
  }
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
  void startupRole;
  void retryPhase;

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
    void retryAttempt;
    void retryReason;
    void isFinalRetry;
    void isWarnRetry;
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Failed to resume thread workflow hook after start");
}

async function startWorkflowAndRetryResume(args: {
  normalizedThreadId: string;
  payload: ThreadMessagePayload;
  startupRole: StartupRole;
  resumeMissReason: ReturnType<typeof classifyResumeMiss>;
  resumeMissError?: unknown;
}): Promise<string | undefined> {
  const { normalizedThreadId, payload, startupRole, resumeMissReason, resumeMissError } = args;
  let startedRunId: string | undefined;
  let startError: unknown;
  let startOutcome: "started" | "raced" | "failed" = "started";

  try {
    const startedRun = await start(slackThreadWorkflow, [normalizedThreadId]);
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

  void payload.kind;
  void startupRole;
  void resumeMissReason;
  void resumeMissError;
  void startError;

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
  const firstResumeAttempt = await attemptResumeHook(normalizedThreadId, payload);
  if (firstResumeAttempt.resumed) {
    return firstResumeAttempt.runId;
  }

  try {
    const firstMissReason = classifyResumeMiss(firstResumeAttempt.error);
    // Scenario A: This caller wins the per-thread startup lease and acts as the
    // leader that attempts to start the workflow and then resumes into its hook.
    const leaderOwnerToken = createStartupLeaseToken();
    const claimedLeaderLease = await claimWorkflowStartupLeaseSafe(
      normalizedThreadId,
      leaderOwnerToken,
      STARTUP_LEASE_TTL_MS
    );

    if (claimedLeaderLease) {
      try {
        return await startWorkflowAndRetryResume({
          normalizedThreadId,
          payload,
          startupRole: "leader",
          resumeMissReason: firstMissReason,
          resumeMissError: firstResumeAttempt.error
        });
      } finally {
        await releaseWorkflowStartupLeaseSafe(normalizedThreadId, leaderOwnerToken);
      }
    }

    // Scenario B: Another caller already holds the startup lease and should be
    // creating the hook. This caller follows and waits with bounded resume polls.

    try {
      return await retryResume(
        normalizedThreadId,
        payload,
        "follower",
        FOLLOWER_RESUME_DELAYS_MS,
        "follower_wait"
      );
    } catch {
      // Scenario C: Follower wait window expired without a resumable hook.
      // Do one final bounded resume window only; avoid starting a duplicate
      // workflow run for the same hook token.
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
    throw error;
  }
}
