import {
  QUEUE_SIGNATURE_MAX_AGE_MS,
  signQueueMessage,
  verifyQueueMessage,
  type QueueVerifyResult,
} from "@/chat/queue/sign";
import {
  conversationQueueMessageSchema,
  type ConversationQueueMessage,
} from "./queue";

const conversationQueueSign = {
  context: "junior.conversation_work_queue.v2",
  schema: conversationQueueMessageSchema,
  separator: ":",
  signatureVersion: "v2" as const,
  parts: (message: ConversationQueueMessage) => [message.conversationId],
};

export const CONVERSATION_WORK_QUEUE_SIGNATURE_MAX_SKEW_MS =
  QUEUE_SIGNATURE_MAX_AGE_MS;
export type ConversationQueueMessageVerificationResult =
  QueueVerifyResult<ConversationQueueMessage>;

/** Sign a conversation queue payload before it crosses the public callback route. */
export function signConversationQueueMessage(
  message: ConversationQueueMessage,
  nowMs = Date.now(),
) {
  return signQueueMessage(conversationQueueSign, message, nowMs);
}

/** Explain whether a queue payload is verified, rejected, or unavailable. */
export function verifyConversationQueueMessage(
  value: unknown,
  nowMs = Date.now(),
): ConversationQueueMessageVerificationResult {
  return verifyQueueMessage(conversationQueueSign, value, nowMs);
}

/** Verify a signed conversation queue payload from the Vercel Queue callback. */
export function verifySignedConversationQueueMessage(
  value: unknown,
  nowMs = Date.now(),
): ConversationQueueMessage | undefined {
  const result = verifyConversationQueueMessage(value, nowMs);
  return result.status === "verified" ? result.message : undefined;
}
