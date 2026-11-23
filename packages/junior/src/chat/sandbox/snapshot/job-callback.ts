/** Receive queue messages for Workspace snapshot builds. */
import { logWarn } from "@/chat/logging";
import { queueCallback } from "@/chat/queue/callback";
import type { QueueMessageMetadata } from "@/chat/queue/provider";
import { processWorkspaceSnapshotJob } from "./job-runner";
import { verifyWorkspaceSnapshotJobMessage } from "./job-queue";

function logWorkspaceSnapshotJobRejected(
  reason: string,
  metadata: QueueMessageMetadata,
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
    // The saved build enforces its one-hour limit.
    maxDeliveries: null,
    onRejected: logWorkspaceSnapshotJobRejected,
    run: async (message) => await processWorkspaceSnapshotJob(message),
    verify: verifyWorkspaceSnapshotJobMessage,
  });
}

/** Create the HTTP route for snapshot build messages. */
export function createVercelWorkspaceSnapshotJobCallback(): (
  request: Request,
) => Promise<Response> {
  return workspaceSnapshotJobCallback().create();
}
