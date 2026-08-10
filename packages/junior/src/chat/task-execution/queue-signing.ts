import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  conversationQueueMessageSchema,
  type ConversationQueueMessage,
} from "./queue";

const CONVERSATION_WORK_QUEUE_SIGNATURE_CONTEXT =
  "junior.conversation_work_queue.v2";
const CONVERSATION_WORK_QUEUE_SIGNATURE_VERSION = "v2";
export const CONVERSATION_WORK_QUEUE_SIGNATURE_MAX_SKEW_MS = 60 * 60 * 1000;

const signedConversationQueueMessageSchema = conversationQueueMessageSchema
  .extend({
    signature: z.string().trim().min(1),
    signatureVersion: z.literal(CONVERSATION_WORK_QUEUE_SIGNATURE_VERSION),
    signedAtMs: z.number().finite(),
  })
  .strict();

type SignedConversationQueueMessage = z.output<
  typeof signedConversationQueueMessageSchema
>;

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

/** Build the canonical signature input for one conversation wake. */
function buildSignedPayload(
  message: ConversationQueueMessage,
  signedAtMs: number,
): string {
  return [
    CONVERSATION_WORK_QUEUE_SIGNATURE_CONTEXT,
    signedAtMs,
    message.conversationId,
  ].join(":");
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function timingSafeMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

/** Parse only the signed conversation queue wire format owned by this module. */
function parseSignedConversationQueueMessage(
  value: unknown,
): SignedConversationQueueMessage | undefined {
  const parsed = signedConversationQueueMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
    signature: signPayload(buildSignedPayload(message, nowMs), secret),
  };
}

/** Explain whether a queue payload is verified, rejected, or unavailable. */
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

  const expected = signPayload(
    buildSignedPayload(message, message.signedAtMs),
    secret,
  );
  if (!timingSafeMatch(expected, message.signature)) {
    return { status: "rejected", reason: "signature_mismatch" };
  }

  return {
    status: "verified",
    message: {
      schemaVersion: message.schemaVersion,
      conversationId: message.conversationId,
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
