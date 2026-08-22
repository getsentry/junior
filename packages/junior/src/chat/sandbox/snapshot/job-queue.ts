/** Send and check Workspace snapshot build messages. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createVercelQueueClient } from "@/chat/vercel-queue-client";

const SIGNATURE_CONTEXT = "junior.workspace_snapshot_queue.v1";
const SIGNATURE_VERSION = "v1";
const SIGNATURE_MAX_AGE_MS = 60 * 60 * 1000;
const QUEUE_RETENTION_SECONDS = SIGNATURE_MAX_AGE_MS / 1000;

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

const signedMessageSchema = workspaceSnapshotJobMessageSchema
  .extend({
    signature: z.string().trim().min(1),
    signatureVersion: z.literal(SIGNATURE_VERSION),
    signedAtMs: z.number().finite(),
  })
  .strict();

type VerificationResult =
  | { message: WorkspaceSnapshotJobMessage; status: "verified" }
  | {
      reason: "expired" | "malformed" | "signature_mismatch";
      status: "rejected";
    };

function queueSecret(): string {
  const secret = process.env.JUNIOR_SECRET?.trim();
  if (!secret) {
    throw new Error("Workspace snapshot queue requires JUNIOR_SECRET");
  }
  return secret;
}

function signature(
  message: WorkspaceSnapshotJobMessage,
  signedAtMs: number,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(
      [
        SIGNATURE_CONTEXT,
        signedAtMs,
        message.workspaceId,
        message.profileHash,
      ].join("\0"),
    )
    .digest("hex");
}

function signaturesMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function signedMessage(message: WorkspaceSnapshotJobMessage) {
  const signedAtMs = Date.now();
  return {
    ...message,
    signedAtMs,
    signatureVersion: SIGNATURE_VERSION,
    signature: signature(message, signedAtMs, queueSecret()),
  };
}

function jobId(message: WorkspaceSnapshotJobMessage): string {
  const digest = createHash("sha256")
    .update(message.workspaceId)
    .update("\0")
    .update(message.profileHash)
    .digest("hex")
    .slice(0, 32);
  return `workspace-snapshot_${digest}`;
}

/** Check that a recent queue message came from Junior. */
export function verifyWorkspaceSnapshotJobMessage(
  value: unknown,
  nowMs = Date.now(),
): VerificationResult {
  const parsed = signedMessageSchema.safeParse(value);
  if (!parsed.success) {
    return { status: "rejected", reason: "malformed" };
  }
  const message = parsed.data;
  if (Math.abs(nowMs - message.signedAtMs) > SIGNATURE_MAX_AGE_MS) {
    return { status: "rejected", reason: "expired" };
  }
  const expected = signature(message, message.signedAtMs, queueSecret());
  if (!signaturesMatch(expected, message.signature)) {
    return { status: "rejected", reason: "signature_mismatch" };
  }
  return {
    status: "verified",
    message: {
      workspaceId: message.workspaceId,
      profileHash: message.profileHash,
    },
  };
}

/** Send a job to build one Workspace snapshot. */
export async function sendWorkspaceSnapshotJob(
  message: WorkspaceSnapshotJobMessage,
): Promise<void> {
  await createVercelQueueClient().send(
    WORKSPACE_SNAPSHOT_JOB_QUEUE_TOPIC,
    signedMessage(message),
    {
      idempotencyKey: jobId(message),
      retentionSeconds: QUEUE_RETENTION_SECONDS,
    },
  );
}
