import { createHmac, timingSafeEqual } from "node:crypto";
import { destinationKey, parseDestination } from "@/chat/destination";
import type { ConversationQueueMessage } from "./queue";

const CONVERSATION_WORK_QUEUE_SIGNATURE_CONTEXT =
  "junior.conversation_work_queue.v1";
const CONVERSATION_WORK_QUEUE_SIGNATURE_VERSION = "v1";
export const CONVERSATION_WORK_QUEUE_SIGNATURE_MAX_SKEW_MS = 60 * 60 * 1000;

interface SignedConversationQueueMessage extends ConversationQueueMessage {
  signature: string;
  signatureVersion: typeof CONVERSATION_WORK_QUEUE_SIGNATURE_VERSION;
  signedAtMs: number;
}

export type ConversationQueueMessageVerificationResult =
  | {
      message: ConversationQueueMessage;
      status: "verified";
    }
  | {
      reason: "expired" | "malformed" | "signature_mismatch";
      status: "rejected";
    }
  | {
      reason: "invalid_clock" | "missing_secret";
      status: "unavailable";
    };

function getConversationWorkQueueSecret(): string | undefined {
  return process.env.JUNIOR_SECRET?.trim() || undefined;
}

function buildSignedPayload(
  message: ConversationQueueMessage,
  signedAtMs: number,
) {
  return [
    CONVERSATION_WORK_QUEUE_SIGNATURE_CONTEXT,
    signedAtMs,
    message.conversationId,
    destinationKey(message.destination),
  ].join(":");
}

function signPayload(
  message: ConversationQueueMessage,
  signedAtMs: number,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(buildSignedPayload(message, signedAtMs))
    .digest("hex");
}

function timingSafeMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function parseSignedConversationQueueMessage(
  value: unknown,
): SignedConversationQueueMessage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const destination = parseDestination(record.destination);
  if (
    typeof record.conversationId !== "string" ||
    !record.conversationId.trim() ||
    !destination ||
    record.signatureVersion !== CONVERSATION_WORK_QUEUE_SIGNATURE_VERSION ||
    typeof record.signedAtMs !== "number" ||
    !Number.isFinite(record.signedAtMs) ||
    typeof record.signature !== "string" ||
    !record.signature.trim()
  ) {
    return undefined;
  }

  return {
    conversationId: record.conversationId,
    destination,
    signature: record.signature,
    signatureVersion: CONVERSATION_WORK_QUEUE_SIGNATURE_VERSION,
    signedAtMs: record.signedAtMs,
  };
}

/** Sign a conversation queue payload before it crosses the public callback route. */
export function signConversationQueueMessage(
  message: ConversationQueueMessage,
  nowMs = Date.now(),
): SignedConversationQueueMessage {
  const secret = getConversationWorkQueueSecret();
  if (!secret) {
    throw new Error(
      "Cannot sign conversation queue message without JUNIOR_SECRET",
    );
  }
  return {
    ...message,
    signedAtMs: nowMs,
    signatureVersion: CONVERSATION_WORK_QUEUE_SIGNATURE_VERSION,
    signature: signPayload(message, nowMs, secret),
  };
}

/** Explain whether a queue payload is verified, rejected, or temporarily unverifiable. */
export function verifyConversationQueueMessage(
  value: unknown,
  nowMs = Date.now(),
): ConversationQueueMessageVerificationResult {
  const message = parseSignedConversationQueueMessage(value);
  if (!message) {
    return { status: "rejected", reason: "malformed" };
  }
  const secret = getConversationWorkQueueSecret();
  if (!secret) {
    return { status: "unavailable", reason: "missing_secret" };
  }
  if (!Number.isFinite(nowMs)) {
    return { status: "unavailable", reason: "invalid_clock" };
  }
  if (
    Math.abs(nowMs - message.signedAtMs) >
    CONVERSATION_WORK_QUEUE_SIGNATURE_MAX_SKEW_MS
  ) {
    return { status: "rejected", reason: "expired" };
  }

  const expected = signPayload(message, message.signedAtMs, secret);
  if (!timingSafeMatch(expected, message.signature)) {
    return { status: "rejected", reason: "signature_mismatch" };
  }

  return {
    status: "verified",
    message: {
      conversationId: message.conversationId,
      destination: message.destination,
    },
  };
}

/** Verify a signed conversation queue payload from the Vercel Queue callback. */
export function verifySignedConversationQueueMessage(
  value: unknown,
  nowMs = Date.now(),
): ConversationQueueMessage | undefined {
  const result = verifyConversationQueueMessage(value, nowMs);
  return result.status === "verified" ? result.message : undefined;
}
