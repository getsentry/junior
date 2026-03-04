import { defineHook, getWorkflowMetadata } from "workflow";
import type { ThreadMessagePayload } from "@/chat/workflow/types";
import { logThreadMessageFailureStep, processThreadMessageStep } from "@/chat/workflow/thread-steps";

const MAX_DEDUP_KEYS = 500;
const DEDUP_TRIM_SIZE = Math.floor(MAX_DEDUP_KEYS / 2);

export const threadMessageHook = defineHook<ThreadMessagePayload>();

function isHookConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("already in use") ||
    message.includes("hook token") ||
    message.includes("hook conflict")
  );
}

function trimSeenDedupKeys(seen: Set<string>): void {
  if (seen.size <= MAX_DEDUP_KEYS) {
    return;
  }

  let deleteCount = seen.size - DEDUP_TRIM_SIZE;
  for (const key of seen) {
    seen.delete(key);
    deleteCount -= 1;
    if (deleteCount <= 0) {
      break;
    }
  }
}

export async function processThreadPayloadStream(
  stream: AsyncIterable<ThreadMessagePayload>,
  workflowRunId?: string
): Promise<void> {
  const seenDedupKeys = new Set<string>();

  for await (const payload of stream) {
    if (seenDedupKeys.has(payload.dedupKey)) {
      continue;
    }

    seenDedupKeys.add(payload.dedupKey);
    trimSeenDedupKeys(seenDedupKeys);

    try {
      await processThreadMessageStep(payload, workflowRunId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await logThreadMessageFailureStep(payload, errorMessage, workflowRunId);
    }
  }
}

export async function slackThreadWorkflow(
  normalizedThreadId: string
): Promise<void> {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();

  let hook: AsyncIterable<ThreadMessagePayload>;
  try {
    hook = threadMessageHook.create({
      token: normalizedThreadId
    });
  } catch (error) {
    if (isHookConflictError(error)) {
      return;
    }
    throw error;
  }

  await processThreadPayloadStream(hook, workflowRunId);
}
