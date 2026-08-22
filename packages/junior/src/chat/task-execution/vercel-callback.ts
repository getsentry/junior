import type { MessageMetadata } from "@vercel/queue";
import type { StateAdapter } from "chat";
import { getChatConfig } from "@/chat/config";
import { logWarn, withLogContext } from "@/chat/logging";
import { createQueueJobCallback } from "@/chat/queue-jobs/callback";
import type { ConversationStore } from "@/chat/conversations/store";
import {
  conversationQueueMessageSchema,
  ConversationQueueMessageRejectedError,
  isConversationQueueMessageRejectedError,
  type ConversationQueueMessage,
  type ConversationWorkQueue,
} from "./queue";
import {
  getVercelConversationWorkQueue,
  resolveConversationWorkQueueTopic,
} from "./vercel-queue";
import {
  processConversationWork,
  type ConversationWorkProcessResult,
  type ConversationWorkerResult,
  type ConversationWorkerContext,
} from "./worker";
import { verifyConversationQueueMessage } from "./queue-signing";

export const CONVERSATION_WORK_VISIBILITY_TIMEOUT_BUFFER_SECONDS = 30;
export const CONVERSATION_WORK_DEV_CONSUMER_GROUP =
  "junior_conversation_work_dev";

export interface ProcessConversationQueueMessageOptions {
  checkInIntervalMs?: number;
  conversationStore?: ConversationStore;
  nowMs?: () => number;
  queue?: ConversationWorkQueue;
  run(context: ConversationWorkerContext): Promise<ConversationWorkerResult>;
  softYieldAfterMs?: number;
  state?: StateAdapter;
}

export interface VercelConversationWorkCallbackOptions extends ProcessConversationQueueMessageOptions {
  topic?: string;
  visibilityTimeoutSeconds?: number;
}

/** Parse the signed callback body before conversation work reaches the worker. */
function parseConversationQueueMessage(
  message: unknown,
): ConversationQueueMessage {
  const parsed = conversationQueueMessageSchema.safeParse(message);
  if (!parsed.success) {
    throw new Error("Conversation queue message is malformed");
  }
  return parsed.data;
}

/** Resolve queue visibility so redelivery waits past the host timeout boundary. */
export function resolveConversationWorkVisibilityTimeoutSeconds(
  functionMaxDurationSeconds = getChatConfig().functionMaxDurationSeconds,
): number {
  return (
    functionMaxDurationSeconds +
    CONVERSATION_WORK_VISIBILITY_TIMEOUT_BUFFER_SECONDS
  );
}

/** Process one Vercel Queue payload with the generic conversation worker. */
export async function processConversationQueueMessage(
  message: unknown,
  options: ProcessConversationQueueMessageOptions,
): Promise<ConversationWorkProcessResult> {
  const parsed = parseConversationQueueMessage(message);
  return await processConversationWork(parsed, {
    checkInIntervalMs: options.checkInIntervalMs,
    conversationStore: options.conversationStore,
    nowMs: options.nowMs,
    queue: options.queue ?? getVercelConversationWorkQueue(),
    run: options.run,
    softYieldAfterMs: options.softYieldAfterMs,
    state: options.state,
  });
}

function logConversationQueueMessageRejected(
  reason: ConversationQueueMessageRejectedError["reason"],
  metadata: MessageMetadata,
  error?: unknown,
): void {
  const conversationId = isConversationQueueMessageRejectedError(error)
    ? error.conversationId
    : undefined;
  withLogContext({ conversationId }, () => {
    logWarn("conversation.queue.message.rejected", {
      "app.queue.consumer_group": metadata.consumerGroup,
      "app.queue.delivery_count": metadata.deliveryCount,
      "app.queue.message_id": metadata.messageId,
      "app.queue.reject_reason": reason,
      "app.queue.topic_name": metadata.topicName,
    });
  });
}

function conversationWorkCallback(
  options: VercelConversationWorkCallbackOptions,
) {
  return createQueueJobCallback<
    ConversationQueueMessage,
    ConversationQueueMessageRejectedError["reason"]
  >({
    consumerGroup: CONVERSATION_WORK_DEV_CONSUMER_GROUP,
    // Conversation execution stores and limits failed attempts in durable state.
    maxDeliveries: null,
    onRejected: logConversationQueueMessageRejected,
    permanentError: (error) =>
      isConversationQueueMessageRejectedError(error) ? error.reason : undefined,
    run: async (message, metadata) => {
      if (!getChatConfig().conversationWorkEnabled) {
        logWarn("conversation.work.processing.disabled", {
          "app.queue.consumer_group": metadata.consumerGroup,
          "app.queue.delivery_count": metadata.deliveryCount,
          "app.queue.message_id": metadata.messageId,
          "app.queue.topic_name": metadata.topicName,
        });
        return;
      }
      await processConversationQueueMessage(message, options);
    },
    topic: resolveConversationWorkQueueTopic(options),
    verify: verifyConversationQueueMessage,
    visibilityTimeoutSeconds:
      options.visibilityTimeoutSeconds ??
      resolveConversationWorkVisibilityTimeoutSeconds(),
  });
}

/** Create the Vercel Queue push callback for conversation work nudges. */
export function createVercelConversationWorkCallback(
  options: VercelConversationWorkCallbackOptions,
): (request: Request) => Promise<Response> {
  return conversationWorkCallback(options).create();
}

/** Register the Vercel Queue local-dev consumer for Nitro's central route dispatcher. */
export function registerVercelConversationWorkDevConsumer(
  options: VercelConversationWorkCallbackOptions,
): (() => void) | undefined {
  return conversationWorkCallback(options).registerDev();
}
