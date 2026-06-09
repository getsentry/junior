import {
  handleCallback,
  QueueClient,
  registerDevConsumer,
  type MessageMetadata,
  type RetryDirective,
} from "@vercel/queue";
import type { StateAdapter } from "chat";
import { getChatConfig } from "@/chat/config";
import { parseDestination } from "@/chat/destination";
import { logWarn } from "@/chat/logging";
import { runWithTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import {
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

function parseConversationQueueMessage(
  message: unknown,
): ConversationQueueMessage {
  const destination = parseDestination(
    (message as { destination?: unknown } | undefined)?.destination,
  );
  if (
    !message ||
    typeof message !== "object" ||
    typeof (message as { conversationId?: unknown }).conversationId !==
      "string" ||
    !(message as { conversationId: string }).conversationId.trim() ||
    !destination
  ) {
    throw new Error(
      "Conversation queue message is missing destination context",
    );
  }
  return {
    conversationId: (message as { conversationId: string }).conversationId,
    destination,
  };
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
    nowMs: options.nowMs,
    queue: options.queue ?? getVercelConversationWorkQueue(),
    run: options.run,
    softYieldAfterMs: options.softYieldAfterMs,
    state: options.state,
  });
}

async function handleConversationQueueMessage(
  message: unknown,
  options: VercelConversationWorkCallbackOptions,
): Promise<void> {
  const verification = verifyConversationQueueMessage(message);
  if (verification.status === "rejected") {
    throw new ConversationQueueMessageRejectedError(
      verification.reason,
      "Unauthorized conversation queue message",
    );
  }
  if (verification.status === "unavailable") {
    throw new Error(
      `Conversation queue message verification unavailable: ${verification.reason}`,
    );
  }
  await runWithTurnRequestDeadline(() =>
    processConversationQueueMessage(verification.message, options),
  );
}

/** Acknowledge permanently rejected queue messages while preserving normal retries. */
function handleConversationQueueRetry(
  error: unknown,
  metadata: MessageMetadata,
): RetryDirective | undefined {
  if (!isConversationQueueMessageRejectedError(error)) {
    return undefined;
  }
  logWarn(
    "conversation_queue_message_rejected",
    error.conversationId ? { conversationId: error.conversationId } : {},
    {
      "app.queue.consumer_group": metadata.consumerGroup,
      "app.queue.delivery_count": metadata.deliveryCount,
      "app.queue.message_id": metadata.messageId,
      "app.queue.reject_reason": error.reason,
      "app.queue.topic_name": metadata.topicName,
    },
    "Conversation queue message rejected without retry",
  );
  return { acknowledge: true };
}

/** Create the Vercel Queue push callback for conversation work nudges. */
export function createVercelConversationWorkCallback(
  options: VercelConversationWorkCallbackOptions,
): (request: Request) => Promise<Response> {
  return handleCallback(
    (message: unknown) => handleConversationQueueMessage(message, options),
    {
      retry: handleConversationQueueRetry,
      visibilityTimeoutSeconds:
        options.visibilityTimeoutSeconds ??
        resolveConversationWorkVisibilityTimeoutSeconds(),
    },
  );
}

/** Register the Vercel Queue local-dev consumer for Nitro's central route dispatcher. */
export function registerVercelConversationWorkDevConsumer(
  options: VercelConversationWorkCallbackOptions,
): (() => void) | undefined {
  if (process.env.NODE_ENV !== "development") {
    return undefined;
  }

  return registerDevConsumer({
    client: new QueueClient(),
    consumerGroup: CONVERSATION_WORK_DEV_CONSUMER_GROUP,
    handler: (message: unknown) =>
      handleConversationQueueMessage(message, options),
    retry: handleConversationQueueRetry,
    topic: resolveConversationWorkQueueTopic(options),
    visibilityTimeoutSeconds:
      options.visibilityTimeoutSeconds ??
      resolveConversationWorkVisibilityTimeoutSeconds(),
  });
}
