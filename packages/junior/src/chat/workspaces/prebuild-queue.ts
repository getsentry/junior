/**
 * Vercel Queue wakeup transport for Workspace snapshot prebuild.
 *
 * Vercel Queues own pending delivery. Heartbeat only enqueues; the queue
 * callback runs the snapshot build with a full function lifetime.
 */
import { createVercelQueueClient } from "@/chat/vercel-queue-client";
import {
  workspacePrebuildTaskId,
  type WorkspacePrebuildQueueMessage,
} from "./prebuild-message";
import {
  WORKSPACE_PREBUILD_QUEUE_SIGNATURE_MAX_SKEW_MS,
  signWorkspacePrebuildQueueMessage,
} from "./prebuild-signing";

export const WORKSPACE_PREBUILD_QUEUE_TOPIC = "junior_workspace_prebuild";
export const WORKSPACE_PREBUILD_QUEUE_RETENTION_SECONDS =
  WORKSPACE_PREBUILD_QUEUE_SIGNATURE_MAX_SKEW_MS / 1000;

function deploymentId(): string | undefined {
  return process.env.VERCEL_DEPLOYMENT_ID?.trim() || undefined;
}

/** Send one Workspace prebuild wakeup through Vercel Queues. */
export async function sendVercelWorkspacePrebuildTask(
  message: WorkspacePrebuildQueueMessage,
): Promise<void> {
  const client = createVercelQueueClient();
  await client.send(
    WORKSPACE_PREBUILD_QUEUE_TOPIC,
    signWorkspacePrebuildQueueMessage(message),
    {
      idempotencyKey: workspacePrebuildTaskId({
        deploymentId: deploymentId(),
        workspaceId: message.workspaceId,
      }),
      retentionSeconds: WORKSPACE_PREBUILD_QUEUE_RETENTION_SECONDS,
    },
  );
}
