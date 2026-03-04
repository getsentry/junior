import { start } from "workflow/api";
import type { ThreadMessagePayload } from "@/chat/workflow/types";
import { slackThreadWorkflow, threadMessageHook } from "@/chat/workflow/thread-workflow";
import { logError, logInfo, logWarn, withContext } from "@/chat/observability";

// Start with a short initial delay so the workflow hook has time to register
// before we attempt the first retry after creating the workflow run.
const RESUME_RETRY_DELAYS_MS = [75, 150, 300, 600, 1000] as const;
const WARN_RETRY_ATTEMPT = 3;

type StartError = Error & { code?: string; name?: string };

interface ResumeAttemptResult {
  resumed: boolean;
  error?: unknown;
  runId?: string;
}

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

async function retryResume(normalizedThreadId: string, payload: ThreadMessagePayload): Promise<string | undefined> {
  let lastError: unknown;

  for (const [index, delayMs] of RESUME_RETRY_DELAYS_MS.entries()) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    const resumeAttempt = await attemptResumeHook(normalizedThreadId, payload);
    if (resumeAttempt.resumed) {
      return resumeAttempt.runId;
    }

    lastError = resumeAttempt.error;
    if (index < RESUME_RETRY_DELAYS_MS.length - 1) {
      const retryAttempt = index + 1;
      const logRetry = retryAttempt >= WARN_RETRY_ATTEMPT ? logWarn : logInfo;
      const retryReason = classifyResumeMiss(resumeAttempt.error);
      logRetry(
        "workflow_route_resume_retry",
        {},
        {
          "app.workflow.retry_attempt": retryAttempt,
          ...(retryReason !== "hook_not_found" ? { "error.message": getErrorMessage(resumeAttempt.error) } : {}),
          "app.workflow.retry_reason": retryReason,
          "app.workflow.retry_severity": retryAttempt >= WARN_RETRY_ATTEMPT ? "warn" : "info"
        },
        "Retrying workflow hook resume after startup race"
      );
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Failed to resume thread workflow hook after start");
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

      let startedRunId: string | undefined;
      let startError: unknown;
      let startOutcome: "started" | "raced" | "failed";
      try {
        const startedRun = await start(slackThreadWorkflow, [normalizedThreadId]);
        startedRunId = startedRun.runId;
        startOutcome = "started";
      } catch (error) {
        if (isBenignStartRaceError(error)) {
          // Expected race: another worker may have started the same thread workflow.
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
          ...(startedRunId ? { "app.workflow.run_id": startedRunId } : {}),
          "app.workflow.start_outcome": startOutcome,
          "app.workflow.resume_miss_reason": classifyResumeMiss(firstResumeAttempt.error),
          ...(classifyResumeMiss(firstResumeAttempt.error) !== "hook_not_found"
            ? { "error.message": getErrorMessage(firstResumeAttempt.error) }
            : {}),
          ...(startError ? { "app.workflow.start_error": getErrorMessage(startError) } : {})
        },
        "Starting thread workflow after expected resume miss"
      );

      if (startOutcome === "failed") {
        throw startError;
      }

      try {
        const resumedRunId = await retryResume(normalizedThreadId, payload);
        return resumedRunId ?? startedRunId;
      } catch (error) {
        logError(
          "workflow_route_failed",
          {},
          {
            "app.workflow.message_kind": payload.kind,
            ...(startedRunId ? { "app.workflow.run_id": startedRunId } : {}),
            "error.message": error instanceof Error ? error.message : String(error)
          },
          "Failed to route message to thread workflow"
        );
        throw error;
      }
    }
  );
}
