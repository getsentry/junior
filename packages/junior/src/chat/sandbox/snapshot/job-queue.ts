/** Send Workspace snapshot build messages. */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  QUEUE_SIGNATURE_MAX_AGE_MS,
  signQueueMessage,
  verifyQueueMessage,
} from "@/chat/queue/sign";
import { createVercelQueueClient } from "@/chat/vercel-queue-client";

const SIGNATURE_CONTEXT = "junior.workspace_snapshot_queue.v1";
const SIGNATURE_VERSION = "v1" as const;

export const WORKSPACE_SNAPSHOT_JOB_QUEUE_TOPIC = "junior_workspace_snapshots";

const workspaceSnapshotJobMessageSchema = z
  .object({
    workspaceId: z.string().uuid(),
    profileHash: z.string().min(1),
  })
  .strict();

export type WorkspaceSnapshotJobMessage = z.output<
  typeof workspaceSnapshotJobMessageSchema
>;

const workspaceSnapshotJobSign = {
  context: SIGNATURE_CONTEXT,
  schema: workspaceSnapshotJobMessageSchema,
  signatureVersion: SIGNATURE_VERSION,
  parts: (message: WorkspaceSnapshotJobMessage) => [
    message.workspaceId,
    message.profileHash,
  ],
};

function jobId(message: WorkspaceSnapshotJobMessage): string {
  const digest = createHash("sha256")
    .update(message.workspaceId)
    .update("\0")
    .update(message.profileHash)
    .digest("hex")
    .slice(0, 32);
  return `workspace-snapshot_${digest}`;
}

/** Sign a Workspace snapshot job for tests and local checks. */
export function signWorkspaceSnapshotJobMessage(
  message: WorkspaceSnapshotJobMessage,
  nowMs = Date.now(),
) {
  return signQueueMessage(workspaceSnapshotJobSign, message, nowMs);
}

/** Check that a recent queue message came from Junior. */
export function verifyWorkspaceSnapshotJobMessage(
  value: unknown,
  nowMs = Date.now(),
) {
  return verifyQueueMessage(workspaceSnapshotJobSign, value, nowMs);
}

async function send(
  message: WorkspaceSnapshotJobMessage,
  idempotencyKey?: string,
): Promise<void> {
  const options: { idempotencyKey?: string; retentionSeconds: number } = {
    retentionSeconds: QUEUE_SIGNATURE_MAX_AGE_MS / 1000,
  };
  if (idempotencyKey) options.idempotencyKey = idempotencyKey;
  await createVercelQueueClient().send(
    WORKSPACE_SNAPSHOT_JOB_QUEUE_TOPIC,
    signWorkspaceSnapshotJobMessage(message),
    options,
  );
}

/** Send a job unless the same Workspace build already has one. */
export async function sendWorkspaceSnapshotJob(
  message: WorkspaceSnapshotJobMessage,
): Promise<void> {
  await send(message, jobId(message));
}

/** Send the next job for a Workspace build that is still running. */
export async function sendNextWorkspaceSnapshotJob(
  message: WorkspaceSnapshotJobMessage,
): Promise<void> {
  await send(message);
}
