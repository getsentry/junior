import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  pluginTaskQueueMessageSchema,
  type PluginTaskQueueMessage,
} from "./task-message";

const SIGNATURE_CONTEXT = "junior.plugin_task_queue.v1";
const SIGNATURE_VERSION = "v1";
export const PLUGIN_TASK_QUEUE_SIGNATURE_MAX_SKEW_MS = 60 * 60 * 1000;

export type PluginTaskQueueRejectReason =
  | "expired"
  | "malformed"
  | "signature_mismatch";

type VerificationResult =
  | { message: PluginTaskQueueMessage; status: "verified" }
  | { reason: PluginTaskQueueRejectReason; status: "rejected" }
  | { reason: "invalid_clock" | "missing_secret"; status: "unavailable" };

const signedPluginTaskQueueMessageSchema = pluginTaskQueueMessageSchema
  .extend({
    signature: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0),
    signatureVersion: z.literal(SIGNATURE_VERSION),
    signedAtMs: z.number().finite(),
  })
  .strict();

type SignedPluginTaskQueueMessage = z.output<
  typeof signedPluginTaskQueueMessageSchema
>;

function queueSecret(): string | undefined {
  return process.env.JUNIOR_SECRET?.trim() || undefined;
}

function signingPayload(
  message: PluginTaskQueueMessage,
  signedAtMs: number,
): string {
  return [
    SIGNATURE_CONTEXT,
    signedAtMs,
    message.plugin,
    message.name,
    message.params.conversationId,
    message.params.sessionId,
  ].join("\0");
}

function hmac(
  message: PluginTaskQueueMessage,
  signedAtMs: number,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(signingPayload(message, signedAtMs))
    .digest("hex");
}

function parseSignedMessage(
  value: unknown,
): SignedPluginTaskQueueMessage | undefined {
  const parsed = signedPluginTaskQueueMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Sign a plugin task payload before it crosses the public queue callback. */
export function signPluginTaskQueueMessage(
  message: PluginTaskQueueMessage,
  nowMs = Date.now(),
): SignedPluginTaskQueueMessage {
  const secret = queueSecret();
  if (!secret) {
    throw new Error(
      "Cannot sign plugin task queue message without JUNIOR_SECRET",
    );
  }
  return {
    ...message,
    signedAtMs: nowMs,
    signatureVersion: SIGNATURE_VERSION,
    signature: hmac(message, nowMs, secret),
  };
}

/** Verify a plugin task payload from the public queue callback route. */
export function verifyPluginTaskQueueMessage(
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
    PLUGIN_TASK_QUEUE_SIGNATURE_MAX_SKEW_MS
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
      name: message.name,
      params: message.params,
      plugin: message.plugin,
    },
  };
}
