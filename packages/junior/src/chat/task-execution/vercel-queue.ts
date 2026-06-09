import { QueueClient } from "@vercel/queue";
import type { SendOptions, SendResult } from "@vercel/queue";
import type {
  ConversationQueueMessage,
  ConversationQueueSendOptions,
  ConversationQueueSendResult,
  ConversationWorkQueue,
} from "./queue";
import {
  CONVERSATION_WORK_QUEUE_SIGNATURE_MAX_SKEW_MS,
  signConversationQueueMessage,
} from "./queue-signing";

export const DEFAULT_CONVERSATION_WORK_QUEUE_TOPIC = "junior_conversation_work";
export const CONVERSATION_WORK_QUEUE_RETENTION_SECONDS =
  CONVERSATION_WORK_QUEUE_SIGNATURE_MAX_SKEW_MS / 1000;

interface QueueSender {
  send<T = unknown>(
    topicName: string,
    payload: T,
    options?: SendOptions,
  ): Promise<SendResult>;
}

export interface VercelConversationWorkQueueOptions {
  client?: QueueSender;
  retentionSeconds?: number;
  topic?: string;
}

let defaultQueue: ConversationWorkQueue | undefined;

/** Resolve the Vercel Queue topic used for conversation wake-up nudges. */
export function resolveConversationWorkQueueTopic(
  options: Pick<VercelConversationWorkQueueOptions, "topic"> = {},
): string {
  const topic = options.topic?.trim();
  return (
    topic ||
    process.env.JUNIOR_CONVERSATION_WORK_QUEUE_TOPIC?.trim() ||
    DEFAULT_CONVERSATION_WORK_QUEUE_TOPIC
  );
}

function toDelaySeconds(
  options: ConversationQueueSendOptions | undefined,
): number | undefined {
  if (!options?.delayMs || options.delayMs <= 0) {
    return undefined;
  }
  return Math.ceil(options.delayMs / 1000);
}

/** Create the Vercel Queue implementation for conversation wake-up nudges. */
export function createVercelConversationWorkQueue(
  options: VercelConversationWorkQueueOptions = {},
): ConversationWorkQueue {
  const topic = resolveConversationWorkQueueTopic(options);
  const client = options.client ?? new QueueClient();

  return {
    async send(
      message: ConversationQueueMessage,
      sendOptions?: ConversationQueueSendOptions,
    ): Promise<ConversationQueueSendResult> {
      const result = await client.send(
        topic,
        signConversationQueueMessage(message),
        {
          idempotencyKey: sendOptions?.idempotencyKey,
          delaySeconds: toDelaySeconds(sendOptions),
          retentionSeconds:
            options.retentionSeconds ??
            CONVERSATION_WORK_QUEUE_RETENTION_SECONDS,
        },
      );
      return result.messageId ? { messageId: result.messageId } : {};
    },
  };
}

/** Return the default production conversation work queue. */
export function getVercelConversationWorkQueue(): ConversationWorkQueue {
  defaultQueue ??= createVercelConversationWorkQueue();
  return defaultQueue;
}
