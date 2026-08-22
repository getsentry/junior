import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  workspaceSnapshotJobMessageSchema,
  type WorkspaceSnapshotJobMessage,
} from "./job-message";

const SIGNATURE_CONTEXT = "junior.workspace_snapshot_queue.v1";
const SIGNATURE_VERSION = "v1";
export const WORKSPACE_SNAPSHOT_JOB_SIGNATURE_MAX_SKEW_MS = 60 * 60 * 1000;

export type WorkspaceSnapshotJobRejectReason =
  | "expired"
  | "malformed"
  | "signature_mismatch";

type VerificationResult =
  | { message: WorkspaceSnapshotJobMessage; status: "verified" }
  | { reason: WorkspaceSnapshotJobRejectReason; status: "rejected" }
  | { reason: "invalid_clock" | "missing_secret"; status: "unavailable" };

const signedWorkspaceSnapshotJobMessageSchema =
  workspaceSnapshotJobMessageSchema
    .extend({
      signature: z
        .string()
        .min(1)
        .refine((value) => value.trim().length > 0),
      signatureVersion: z.literal(SIGNATURE_VERSION),
      signedAtMs: z.number().finite(),
    })
    .strict();

type SignedWorkspaceSnapshotJobMessage = z.output<
  typeof signedWorkspaceSnapshotJobMessageSchema
>;

function queueSecret(): string | undefined {
  return process.env.JUNIOR_SECRET?.trim() || undefined;
}

function signingPayload(
  message: WorkspaceSnapshotJobMessage,
  signedAtMs: number,
): string {
  return [
    SIGNATURE_CONTEXT,
    signedAtMs,
    message.workspaceId,
    message.profileHash,
  ].join("\0");
}

function hmac(
  message: WorkspaceSnapshotJobMessage,
  signedAtMs: number,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(signingPayload(message, signedAtMs))
    .digest("hex");
}

function parseSignedMessage(
  value: unknown,
): SignedWorkspaceSnapshotJobMessage | undefined {
  const parsed = signedWorkspaceSnapshotJobMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Sign a snapshot job payload before it crosses the public queue callback. */
export function signWorkspaceSnapshotJobMessage(
  message: WorkspaceSnapshotJobMessage,
  nowMs = Date.now(),
): SignedWorkspaceSnapshotJobMessage {
  const secret = queueSecret();
  if (!secret) {
    throw new Error(
      "Cannot sign workspace snapshot queue message without JUNIOR_SECRET",
    );
  }
  return {
    ...message,
    signedAtMs: nowMs,
    signatureVersion: SIGNATURE_VERSION,
    signature: hmac(message, nowMs, secret),
  };
}

/** Verify a snapshot job payload from the public queue callback route. */
export function verifyWorkspaceSnapshotJobMessage(
  value: unknown,
  nowMs = Date.now(),
): VerificationResult {
  const message = parseSignedMessage(value);
  if (!message) {
    return { status: "rejected", reason: "malformed" };
  }
  const secret = queueSecret();
  if (!secret) {
    return { status: "unavailable", reason: "missing_secret" };
  }
  if (!Number.isFinite(nowMs)) {
    return { status: "unavailable", reason: "invalid_clock" };
  }
  if (
    Math.abs(nowMs - message.signedAtMs) >
    WORKSPACE_SNAPSHOT_JOB_SIGNATURE_MAX_SKEW_MS
  ) {
    return { status: "rejected", reason: "expired" };
  }

  const expected = Buffer.from(hmac(message, message.signedAtMs, secret));
  const actual = Buffer.from(message.signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
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
