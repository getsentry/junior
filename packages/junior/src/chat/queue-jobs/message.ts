/** Shared signed wire format for work delivered through public queue callbacks. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const QUEUE_MESSAGE_SIGNATURE_MAX_AGE_MS = 60 * 60 * 1000;

export type QueueMessageRejectReason =
  | "expired"
  | "malformed"
  | "signature_mismatch";

export type QueueMessageVerificationResult<Message> =
  | { message: Message; status: "verified" }
  | { reason: QueueMessageRejectReason; status: "rejected" }
  | { reason: "invalid_clock" | "missing_secret"; status: "unavailable" };

type SignedFields<Version extends string> = {
  signature: string;
  signatureVersion: Version;
  signedAtMs: number;
};

export interface QueueMessageCodec<
  Message extends object,
  Version extends string,
> {
  maxAgeMs: number;
  sign(message: Message, nowMs?: number): Message & SignedFields<Version>;
  verify(
    value: unknown,
    nowMs?: number,
  ): QueueMessageVerificationResult<Message>;
}

interface QueueMessageCodecOptions<Message extends object, Version extends string> {
  context: string;
  maxAgeMs?: number;
  schema: z.ZodType<Message>;
  signatureVersion: Version;
  signingParts(message: Message): readonly string[];
  separator?: string;
}

function queueSecret(): string | undefined {
  return process.env.JUNIOR_SECRET?.trim() || undefined;
}

function signature(args: {
  context: string;
  messageParts: readonly string[];
  secret: string;
  signedAtMs: number;
  separator: string;
}): string {
  return createHmac("sha256", args.secret)
    .update(
      [args.context, args.signedAtMs, ...args.messageParts].join(args.separator),
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

function unsignedValue(value: Record<string, unknown>): Record<string, unknown> {
  const {
    signature: _signature,
    signatureVersion: _signatureVersion,
    signedAtMs: _signedAtMs,
    ...message
  } = value;
  return message;
}

/** Create one signed queue message codec while keeping the job payload local. */
export function createQueueMessageCodec<
  Message extends object,
  Version extends string,
>(
  options: QueueMessageCodecOptions<Message, Version>,
): QueueMessageCodec<Message, Version> {
  const maxAgeMs = options.maxAgeMs ?? QUEUE_MESSAGE_SIGNATURE_MAX_AGE_MS;
  const signedFieldsSchema = z.object({
    signature: z.string().trim().min(1),
    signatureVersion: z.literal(options.signatureVersion),
    signedAtMs: z.number().finite(),
  });

  return {
    maxAgeMs,
    sign(message, nowMs = Date.now()) {
      const secret = queueSecret();
      if (!secret) {
        throw new Error("Cannot sign queue message without JUNIOR_SECRET");
      }
      if (!Number.isFinite(nowMs)) {
        throw new Error("Cannot sign queue message with an invalid clock");
      }
      return {
        ...message,
        signedAtMs: nowMs,
        signatureVersion: options.signatureVersion,
        signature: signature({
          context: options.context,
          messageParts: options.signingParts(message),
          secret,
          signedAtMs: nowMs,
          separator: options.separator ?? "\0",
        }),
      };
    },
    verify(value, nowMs = Date.now()) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { status: "rejected", reason: "malformed" };
      }
      const signed = signedFieldsSchema.safeParse(value);
      const message = options.schema.safeParse(
        unsignedValue(value as Record<string, unknown>),
      );
      if (!signed.success || !message.success) {
        return { status: "rejected", reason: "malformed" };
      }
      const secret = queueSecret();
      if (!secret) {
        return { status: "unavailable", reason: "missing_secret" };
      }
      if (!Number.isFinite(nowMs)) {
        return { status: "unavailable", reason: "invalid_clock" };
      }
      if (Math.abs(nowMs - signed.data.signedAtMs) > maxAgeMs) {
        return { status: "rejected", reason: "expired" };
      }
      const expected = signature({
        context: options.context,
        messageParts: options.signingParts(message.data),
        secret,
        signedAtMs: signed.data.signedAtMs,
        separator: options.separator ?? "\0",
      });
      if (!signaturesMatch(expected, signed.data.signature)) {
        return { status: "rejected", reason: "signature_mismatch" };
      }
      return { status: "verified", message: message.data };
    },
  };
}
