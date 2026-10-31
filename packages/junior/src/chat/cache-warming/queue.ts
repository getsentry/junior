/** Send and receive delayed cache warmup messages. */
import { z } from "zod";
import { isExperimentalFeatureEnabled } from "@/chat/experimental";
import { logWarn } from "@/chat/logging";
import { queueCallback } from "@/chat/queue/callback";
import {
  getQueueProvider,
  type QueueConsumer,
  type QueueMessageMetadata,
} from "@/chat/queue/provider";
import {
  QUEUE_SIGNATURE_MAX_AGE_MS,
  signQueueMessage,
  verifyQueueMessage,
} from "@/chat/queue/sign";

/** Deploy topic name. Keep stable for Vercel queue wiring. */
export const CACHE_WARMUP_QUEUE_TOPIC = "junior_cache_warmups";

const CACHE_WARMUP_DEV_CONSUMER_GROUP = "junior_cache_warmups_dev";

const cacheWarmupMessageSchema = z
  .object({
    conversationId: z.string().min(1),
    cycle: z.number().int().positive(),
    generation: z.string().min(1),
  })
  .strict();

/** One scheduled warmup for one idle period of one Conversation. */
export type CacheWarmupMessage = z.output<typeof cacheWarmupMessageSchema>;

const cacheWarmupSign = {
  context: "junior.cache_warmup_queue.v1",
  schema: cacheWarmupMessageSchema,
  signatureVersion: "v1" as const,
  parts: (message: CacheWarmupMessage) => [
    message.conversationId,
    message.generation,
    String(message.cycle),
  ],
};

/** Send a warmup message that is delivered after `delayMs`. */
export async function sendCacheWarmup(
  message: CacheWarmupMessage,
  delayMs: number,
): Promise<void> {
  await getQueueProvider().send(
    CACHE_WARMUP_QUEUE_TOPIC,
    signQueueMessage(cacheWarmupSign, message),
    {
      delaySeconds: Math.max(0, Math.floor(delayMs / 1000)),
      // A late warmup cannot refresh an expired cache, so drop it.
      retentionSeconds: Math.min(
        QUEUE_SIGNATURE_MAX_AGE_MS / 1000,
        Math.ceil(delayMs / 1000) + 120,
      ),
      idempotencyKey: `cache-warmup_${message.generation}_${message.cycle}`,
    },
  );
}

function logCacheWarmupRejected(
  reason: string,
  metadata: QueueMessageMetadata,
  error?: unknown,
): void {
  logWarn("cache_warming.queue_message.rejected", {
    "app.queue.consumer_group": metadata.consumerGroup,
    "app.queue.delivery_count": metadata.deliveryCount,
    "app.queue.message_id": metadata.messageId,
    "app.queue.reject_reason": reason,
    "app.queue.topic_name": metadata.topicName,
    ...(error instanceof Error
      ? { "exception.message": error.message }
      : undefined),
  });
}

function cacheWarmupCallback() {
  return queueCallback<CacheWarmupMessage>({
    consumerGroup: CACHE_WARMUP_DEV_CONSUMER_GROUP,
    // A retry reaches the cache too late to help.
    maxDeliveries: 1,
    onRejected: logCacheWarmupRejected,
    run: async (message) => {
      const { runCacheWarmup } = await import("./warmup");
      await runCacheWarmup(message);
    },
    skip: () => !isExperimentalFeatureEnabled("cache-warming"),
    topic: CACHE_WARMUP_QUEUE_TOPIC,
    verify: (value) => verifyQueueMessage(cacheWarmupSign, value),
  });
}

/** Create the HTTP route for cache warmup messages. */
export function createVercelCacheWarmupCallback(): (
  request: Request,
) => Promise<Response> {
  return cacheWarmupCallback().create();
}

/** Return the queue consumer for cache warmups, for a pulling queue worker. */
export function cacheWarmupQueueConsumer(): QueueConsumer {
  return cacheWarmupCallback().consumer;
}

/** Receive cache warmup messages during local development. */
export function registerVercelCacheWarmupDevConsumer():
  | (() => void)
  | undefined {
  return cacheWarmupCallback().registerDev();
}
