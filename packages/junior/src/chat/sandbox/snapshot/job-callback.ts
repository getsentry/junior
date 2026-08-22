/**
 * Vercel Queue callback for Workspace snapshot builds.
 *
 * The queue payload is a bounded job request. Vercel retries thrown failures,
 * while malformed payloads are acknowledged without executing builder code.
 */
import {
  handleCallback,
  registerDevConsumer,
  type MessageMetadata,
  type RetryDirective,
} from "@vercel/queue";
import { logWarn } from "@/chat/logging";
import { runWithTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import { createVercelQueueClient } from "@/chat/vercel-queue-client";
import { processWorkspaceSnapshotJob } from "./job-runner";
import { WORKSPACE_SNAPSHOT_JOB_QUEUE_TOPIC } from "./job-queue";
import {
  verifyWorkspaceSnapshotJobMessage,
  type WorkspaceSnapshotJobRejectReason,
} from "./job-signing";

export const WORKSPACE_SNAPSHOT_JOB_DEV_CONSUMER_GROUP =
  "junior_workspace_snapshots_dev";
const WORKSPACE_SNAPSHOT_JOB_MAX_DELIVERIES = 5;

function logWorkspaceSnapshotJobRejected(
  reason: WorkspaceSnapshotJobRejectReason,
  metadata: MessageMetadata,
): void {
  logWarn("workspace.snapshot.job.queue_message.rejected", {
    "app.queue.consumer_group": metadata.consumerGroup,
    "app.queue.delivery_count": metadata.deliveryCount,
    "app.queue.message_id": metadata.messageId,
    "app.queue.reject_reason": reason,
    "app.queue.topic_name": metadata.topicName,
  });
}

/** Parse the queue payload and run only the referenced snapshot build. */
async function handleWorkspaceSnapshotJobMessage(
  message: unknown,
  metadata: MessageMetadata,
): Promise<void> {
  const verification = verifyWorkspaceSnapshotJobMessage(message);
  if (verification.status === "rejected") {
    logWorkspaceSnapshotJobRejected(verification.reason, metadata);
    return;
  }
  if (verification.status === "unavailable") {
    throw new Error(
      `Workspace snapshot queue message verification unavailable: ${verification.reason}`,
    );
  }
  await runWithTurnRequestDeadline(() =>
    processWorkspaceSnapshotJob(verification.message),
  );
}

/** Bound poison-message retries while preserving normal transient retries. */
function handleWorkspaceSnapshotJobRetry(
  _error: unknown,
  metadata: MessageMetadata,
): RetryDirective | undefined {
  if (metadata.deliveryCount >= WORKSPACE_SNAPSHOT_JOB_MAX_DELIVERIES) {
    return { acknowledge: true };
  }
  return undefined;
}

/** Create the Vercel Queue push callback for Workspace snapshot builds. */
export function createVercelWorkspaceSnapshotJobCallback(): (
  request: Request,
) => Promise<Response> {
  return handleCallback(
    (message, metadata) => handleWorkspaceSnapshotJobMessage(message, metadata),
    {
      retry: handleWorkspaceSnapshotJobRetry,
    },
  );
}

/** Register the Vercel Queue local-dev consumer for Workspace snapshot builds. */
export function registerVercelWorkspaceSnapshotJobDevConsumer():
  | (() => void)
  | undefined {
  if (process.env.NODE_ENV !== "development") {
    return undefined;
  }
  return registerDevConsumer({
    client: createVercelQueueClient(),
    consumerGroup: WORKSPACE_SNAPSHOT_JOB_DEV_CONSUMER_GROUP,
    handler: (message, metadata) =>
      handleWorkspaceSnapshotJobMessage(message, metadata),
    retry: handleWorkspaceSnapshotJobRetry,
    topic: WORKSPACE_SNAPSHOT_JOB_QUEUE_TOPIC,
  });
}
