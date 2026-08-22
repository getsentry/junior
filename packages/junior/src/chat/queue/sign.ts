/** Sign and check queue messages before public callbacks run them. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const QUEUE_SIGNATURE_MAX_AGE_MS = 60 * 60 * 1000;

export type QueueRejectReason =
  | "expired"
  | "malformed"
  | "signature_mismatch";

export type QueueVerifyResult<Message> =
  | { status: "verified"; message: Message }
  | { status: "rejected"; reason: QueueRejectReason }
  | { status: "unavailable"; reason: "invalid_clock" | "missing_secret" };

export interface QueueSignConfig<Message extends object, Version extends string> {
  context: string;
  maxAgeMs?: number;
  schema: z.ZodType<Message>;
  /** Kept for jobs that already signed with `:` instead of null bytes. */
  separator?: string;
  signatureVersion: Version;
  parts(message: Message): readonly string[];
}

function secret(): string | undefined {
  return process.env.JUNIOR_SECRET?.trim() || undefined;
}

function digest(args: {
  context: string;
  parts: readonly string[];
  secret: string;
  separator: string;
  signedAtMs: number;
}): string {
  return createHmac("sha256", args.secret)
    .update(
      [args.context, args.signedAtMs, ...args.parts].join(args.separator),
    )
    .digest("hex");
}

function sameHex(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function body(value: Record<string, unknown>): Record<string, unknown> {
  const {
    signature: _signature,
    signatureVersion: _signatureVersion,
    signedAtMs: _signedAtMs,
    ...message
  } = value;
  return message;
}

/** Sign one queue message. */
export function signQueueMessage<
  Message extends object,
  Version extends string,
>(
  config: QueueSignConfig<Message, Version>,
  message: Message,
  nowMs = Date.now(),
): Message & {
  signature: string;
  signatureVersion: Version;
  signedAtMs: number;
} {
  const key = secret();
  if (!key) {
    throw new Error("Cannot sign queue message without JUNIOR_SECRET");
  }
  if (!Number.isFinite(nowMs)) {
    throw new Error("Cannot sign queue message with an invalid clock");
  }
  const separator = config.separator ?? "\0";
  return {
    ...message,
    signedAtMs: nowMs,
    signatureVersion: config.signatureVersion,
    signature: digest({
      context: config.context,
      parts: config.parts(message),
      secret: key,
      separator,
      signedAtMs: nowMs,
    }),
  };
}

/** Check one signed queue message. */
export function verifyQueueMessage<
  Message extends object,
  Version extends string,
>(
  config: QueueSignConfig<Message, Version>,
  value: unknown,
  nowMs = Date.now(),
): QueueVerifyResult<Message> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "rejected", reason: "malformed" };
  }

  const signed = z
    .object({
      signature: z.string().trim().min(1),
      signatureVersion: z.literal(config.signatureVersion),
      signedAtMs: z.number().finite(),
    })
    .safeParse(value);
  const message = config.schema.safeParse(body(value as Record<string, unknown>));
  if (!signed.success || !message.success) {
    return { status: "rejected", reason: "malformed" };
  }

  const key = secret();
  if (!key) {
    return { status: "unavailable", reason: "missing_secret" };
  }
  if (!Number.isFinite(nowMs)) {
    return { status: "unavailable", reason: "invalid_clock" };
  }

  const maxAgeMs = config.maxAgeMs ?? QUEUE_SIGNATURE_MAX_AGE_MS;
  if (Math.abs(nowMs - signed.data.signedAtMs) > maxAgeMs) {
    return { status: "rejected", reason: "expired" };
  }

  const expected = digest({
    context: config.context,
    parts: config.parts(message.data),
    secret: key,
    separator: config.separator ?? "\0",
    signedAtMs: signed.data.signedAtMs,
  });
  if (!sameHex(expected, signed.data.signature)) {
    return { status: "rejected", reason: "signature_mismatch" };
  }

  return { status: "verified", message: message.data };
}
