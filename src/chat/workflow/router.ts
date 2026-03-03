import { start } from "workflow/api";
import type { ThreadMessagePayload } from "@/chat/workflow/types";
import { slackThreadWorkflow, threadMessageHook } from "@/chat/workflow/thread-workflow";
import { logError, logInfo, logWarn } from "@/chat/observability";

const RESUME_RETRY_DELAYS_MS = [0, 50, 100, 200, 400] as const;

interface ResumeAttemptResult {
  resumed: boolean;
  error?: unknown;
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
      return { resumed: true };
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

async function retryResume(normalizedThreadId: string, payload: ThreadMessagePayload): Promise<void> {
  let lastError: unknown;

  for (const [index, delayMs] of RESUME_RETRY_DELAYS_MS.entries()) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    const resumeAttempt = await attemptResumeHook(normalizedThreadId, payload);
    if (resumeAttempt.resumed) {
      return;
    }

    lastError = resumeAttempt.error;
    if (index < RESUME_RETRY_DELAYS_MS.length - 1) {
      logWarn(
        "workflow_route_resume_retry",
        {
          slackThreadId: normalizedThreadId,
          slackChannelId: payload.thread.channelId,
          slackUserId: payload.message.author.userId
        },
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
): Promise<void> {
  const firstResumeAttempt = await attemptResumeHook(normalizedThreadId, payload);
  if (firstResumeAttempt.resumed) {
    return;
  }

  logInfo(
    "workflow_route_start_attempt",
    {
      slackThreadId: normalizedThreadId,
      slackChannelId: payload.thread.channelId,
      slackUserId: payload.message.author.userId
    },
    {
      "app.workflow.message_kind": payload.kind,
      "error.message":
        firstResumeAttempt.error instanceof Error ? firstResumeAttempt.error.message : String(firstResumeAttempt.error)
    },
    "Starting thread workflow after resume miss"
  );

  try {
    await start(slackThreadWorkflow, [normalizedThreadId]);
  } catch {
    // Expected race: another worker may have started the same thread workflow.
  }

  try {
    await retryResume(normalizedThreadId, payload);
  } catch (error) {
    logError(
      "workflow_route_failed",
      {
        slackThreadId: normalizedThreadId,
        slackChannelId: payload.thread.channelId,
        slackUserId: payload.message.author.userId
      },
      {
        "app.workflow.message_kind": payload.kind,
        "error.message": error instanceof Error ? error.message : String(error)
      },
      "Failed to route message to thread workflow"
    );
    throw error;
  }
}
