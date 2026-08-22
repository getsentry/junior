/**
 * Vercel Queue transport for Workspace snapshot builds.
 *
 * The queue only wakes the builder. SQL owns durable build state.
 */
import { createVercelQueueClient } from "@/chat/vercel-queue-client";
import {
  workspaceSnapshotJobId,
  type WorkspaceSnapshotJobMessage,
} from "./job-message";
import {
  WORKSPACE_SNAPSHOT_JOB_SIGNATURE_MAX_SKEW_MS,
  signWorkspaceSnapshotJobMessage,
} from "./job-signing";

export const WORKSPACE_SNAPSHOT_JOB_QUEUE_TOPIC = "junior_workspace_snapshots";
export const WORKSPACE_SNAPSHOT_JOB_QUEUE_RETENTION_SECONDS =
  WORKSPACE_SNAPSHOT_JOB_SIGNATURE_MAX_SKEW_MS / 1000;

/** Enqueue one Workspace snapshot build wakeup. */
export async function sendWorkspaceSnapshotJob(
  message: WorkspaceSnapshotJobMessage,
): Promise<void> {
  const client = createVercelQueueClient();
  await client.send(
    WORKSPACE_SNAPSHOT_JOB_QUEUE_TOPIC,
    signWorkspaceSnapshotJobMessage(message),
    {
      idempotencyKey: workspaceSnapshotJobId(message),
      retentionSeconds: WORKSPACE_SNAPSHOT_JOB_QUEUE_RETENTION_SECONDS,
    },
  );
}
