/** Receive Vercel Queue messages for Workspace snapshot builds. */
import {
  handleCallback,
  registerDevConsumer,
  type MessageMetadata,
} from "@vercel/queue";
import { logWarn } from "@/chat/logging";
import { runWithTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import { createVercelQueueClient } from "@/chat/vercel-queue-client";
import { processWorkspaceSnapshotJob } from "./job-runner";
import {
  verifyWorkspaceSnapshotJobMessage,
  WORKSPACE_SNAPSHOT_JOB_QUEUE_TOPIC,
} from "./job-queue";

export const WORKSPACE_SNAPSHOT_JOB_DEV_CONSUMER_GROUP =
  "junior_workspace_snapshots_dev";
function logWorkspaceSnapshotJobRejected(
  reason: "expired" | "malformed" | "signature_mismatch",
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

/** Check a queue message before it starts a snapshot build. */
async function handleWorkspaceSnapshotJobMessage(
  message: unknown,
  metadata: MessageMetadata,
): Promise<void> {
  const verification = verifyWorkspaceSnapshotJobMessage(message);
  if (verification.status === "rejected") {
    logWorkspaceSnapshotJobRejected(verification.reason, metadata);
    return;
  }
  await runWithTurnRequestDeadline(() =>
    processWorkspaceSnapshotJob(verification.message),
  );
}

/** Create the HTTP route for snapshot build messages. */
export function createVercelWorkspaceSnapshotJobCallback(): (
  request: Request,
) => Promise<Response> {
  return handleCallback((message, metadata) =>
    handleWorkspaceSnapshotJobMessage(message, metadata),
  );
}

/** Receive snapshot build messages during local development. */
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
    topic: WORKSPACE_SNAPSHOT_JOB_QUEUE_TOPIC,
  });
}
