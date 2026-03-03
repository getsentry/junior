import { start } from "workflow/api";
import type { ThreadMessagePayload } from "@/chat/workflow/types";
import { slackThreadWorkflow, threadMessageHook } from "@/chat/workflow/thread-workflow";
import { logError, logInfo, logWarn, withContext } from "@/chat/observability";

const RESUME_RETRY_DELAYS_MS = [0, 50, 100, 200, 400] as const;

interface ResumeAttemptResult {
  resumed: boolean;
  error?: unknown;
  runId?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
      logWarn(
        "workflow_route_resume_retry",
        {},
        {
          "app.workflow.retry_attempt": index + 1,
          "error.message":
            resumeAttempt.error instanceof Error ? resumeAttempt.error.message : String(resumeAttempt.error)
        },
        "Retrying workflow hook resume"
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
      slackChannelId: payload.thread.channelId,
      slackUserId: payload.message.author.userId
    },
    async () => {
      const firstResumeAttempt = await attemptResumeHook(normalizedThreadId, payload);
      if (firstResumeAttempt.resumed) {
        return firstResumeAttempt.runId;
      }

      let startedRunId: string | undefined;
      let startError: unknown;
      try {
        const startedRun = await start(slackThreadWorkflow, [normalizedThreadId]);
        startedRunId = startedRun.runId;
      } catch (error) {
        // Expected race: another worker may have started the same thread workflow.
        startError = error;
      }

      logInfo(
        "workflow_route_start_attempt",
        {},
        {
          "app.workflow.message_kind": payload.kind,
          ...(startedRunId ? { "app.workflow.run_id": startedRunId } : {}),
          "app.workflow.start_outcome": startedRunId ? "started" : "raced_or_failed",
          "error.message":
            firstResumeAttempt.error instanceof Error ? firstResumeAttempt.error.message : String(firstResumeAttempt.error),
          ...(startError
            ? { "app.workflow.start_error": startError instanceof Error ? startError.message : String(startError) }
            : {})
        },
        "Starting thread workflow after resume miss"
      );

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
