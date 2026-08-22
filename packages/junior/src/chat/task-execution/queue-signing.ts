import { createQueueMessageCodec } from "@/chat/queue-jobs/message";
import {
  conversationQueueMessageSchema,
  type ConversationQueueMessage,
} from "./queue";

const conversationQueueMessageCodec =
  createQueueMessageCodec<ConversationQueueMessage, "v2">({
    context: "junior.conversation_work_queue.v2",
    schema: conversationQueueMessageSchema,
    separator: ":",
    signatureVersion: "v2",
    signingParts: (message) => [message.conversationId],
  });

export const CONVERSATION_WORK_QUEUE_SIGNATURE_MAX_SKEW_MS =
  conversationQueueMessageCodec.maxAgeMs;
export type ConversationQueueMessageVerificationResult = ReturnType<
  typeof conversationQueueMessageCodec.verify
>;

/** Sign a conversation queue payload before it crosses the public callback route. */
export function signConversationQueueMessage(
  message: ConversationQueueMessage,
  nowMs = Date.now(),
) {
  return conversationQueueMessageCodec.sign(message, nowMs);
}

/** Explain whether a queue payload is verified, rejected, or unavailable. */
export function verifyConversationQueueMessage(
  value: unknown,
  nowMs = Date.now(),
): ConversationQueueMessageVerificationResult {
  return conversationQueueMessageCodec.verify(value, nowMs);
}

/** Verify a signed conversation queue payload from the Vercel Queue callback. */
export function verifySignedConversationQueueMessage(
  value: unknown,
  nowMs = Date.now(),
): ConversationQueueMessage | undefined {
  const result = verifyConversationQueueMessage(value, nowMs);
  return result.status === "verified" ? result.message : undefined;
}
