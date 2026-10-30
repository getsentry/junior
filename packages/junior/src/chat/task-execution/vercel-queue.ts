import { withSpan } from "@/chat/logging";
import { getQueueProvider, type QueueProvider } from "@/chat/queue/provider";
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
export interface VercelConversationWorkQueueOptions {
  client?: Pick<QueueProvider, "send">;
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
  const client = options.client ?? getQueueProvider();

  return {
    async send(
      message: ConversationQueueMessage,
      sendOptions?: ConversationQueueSendOptions,
    ): Promise<ConversationQueueSendResult> {
      const payload = signConversationQueueMessage(message);
      return await withSpan(
        "conversation.work.publish",
        "queue.publish",
        { conversationId: message.conversationId },
        async (setSpanAttributes) => {
          const result = await client.send(topic, payload, {
            idempotencyKey: sendOptions?.idempotencyKey,
            delaySeconds: toDelaySeconds(sendOptions),
            retentionSeconds:
              options.retentionSeconds ??
              CONVERSATION_WORK_QUEUE_RETENTION_SECONDS,
          });
          if (!result.messageId) {
            return {};
          }
          setSpanAttributes({ "messaging.message.id": result.messageId });
          return { messageId: result.messageId };
        },
        {
          "messaging.destination.name": topic,
          // The queue provider sends the payload as these UTF-8 JSON bytes.
          "messaging.message.body.size": Buffer.byteLength(
            JSON.stringify(payload),
          ),
          "messaging.system": getQueueProvider().messagingSystem,
        },
      );
    },
  };
}

/** Return the default production conversation work queue. */
export function getVercelConversationWorkQueue(): ConversationWorkQueue {
  defaultQueue ??= createVercelConversationWorkQueue();
  return defaultQueue;
}
