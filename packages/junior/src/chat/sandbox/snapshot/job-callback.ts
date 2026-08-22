/** Receive Vercel Queue messages for Workspace snapshot builds. */
import type { MessageMetadata } from "@vercel/queue";
import { logWarn } from "@/chat/logging";
import { queueCallback } from "@/chat/queue/callback";
import { processWorkspaceSnapshotJob } from "./job-runner";
import {
  verifyWorkspaceSnapshotJobMessage,
  WORKSPACE_SNAPSHOT_JOB_QUEUE_TOPIC,
} from "./job-queue";

export const WORKSPACE_SNAPSHOT_JOB_DEV_CONSUMER_GROUP =
  "junior_workspace_snapshots_dev";
function logWorkspaceSnapshotJobRejected(
  reason: string,
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

function workspaceSnapshotJobCallback() {
  return queueCallback({
    consumerGroup: WORKSPACE_SNAPSHOT_JOB_DEV_CONSUMER_GROUP,
    // The saved build enforces its one-hour limit.
    maxDeliveries: null,
    onRejected: logWorkspaceSnapshotJobRejected,
    run: async (message) => await processWorkspaceSnapshotJob(message),
    topic: WORKSPACE_SNAPSHOT_JOB_QUEUE_TOPIC,
    verify: verifyWorkspaceSnapshotJobMessage,
  });
}

/** Create the HTTP route for snapshot build messages. */
export function createVercelWorkspaceSnapshotJobCallback(): (
  request: Request,
) => Promise<Response> {
  return workspaceSnapshotJobCallback().create();
}

/** Receive snapshot build messages during local development. */
export function registerVercelWorkspaceSnapshotJobDevConsumer():
  | (() => void)
  | undefined {
  return workspaceSnapshotJobCallback().registerDev();
}
