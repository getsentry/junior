/** Receive background compaction jobs from the queue. */
import { logWarn } from "@/chat/logging";
import { queueCallback } from "@/chat/queue/callback";
import type {
  QueueConsumer,
  QueueMessageMetadata,
} from "@/chat/queue/provider";
import { processBackgroundCompaction } from "./background-compaction";
import {
  BACKGROUND_COMPACTION_QUEUE_TOPIC,
  verifyBackgroundCompactionMessage,
} from "./background-compaction-queue";

const BACKGROUND_COMPACTION_DEV_CONSUMER_GROUP =
  "junior_context_compaction_dev";
// The job records model failures itself. Retries cover storage errors only.
const BACKGROUND_COMPACTION_MAX_DELIVERIES = 3;

function logRejected(reason: string, metadata: QueueMessageMetadata): void {
  logWarn("context_compaction.queue_message.rejected", {
    "app.queue.consumer_group": metadata.consumerGroup,
    "app.queue.delivery_count": metadata.deliveryCount,
    "app.queue.message_id": metadata.messageId,
    "app.queue.reject_reason": reason,
    "app.queue.topic_name": metadata.topicName,
  });
}

function backgroundCompactionCallback() {
  return queueCallback({
    consumerGroup: BACKGROUND_COMPACTION_DEV_CONSUMER_GROUP,
    maxDeliveries: BACKGROUND_COMPACTION_MAX_DELIVERIES,
    onRejected: logRejected,
    run: async (message, metadata) =>
      await processBackgroundCompaction(message, {
        enqueuedAtMs: metadata.createdAt.getTime(),
      }),
    topic: BACKGROUND_COMPACTION_QUEUE_TOPIC,
    verify: verifyBackgroundCompactionMessage,
  });
}

/** Create the HTTP route for background compaction jobs. */
export function createVercelBackgroundCompactionCallback(): (
  request: Request,
) => Promise<Response> {
  return backgroundCompactionCallback().create();
}

/** Return the queue consumer for background compaction, for a pulling worker. */
export function backgroundCompactionQueueConsumer(): QueueConsumer {
  return backgroundCompactionCallback().consumer;
}

/** Receive background compaction jobs during local development. */
export function registerVercelBackgroundCompactionDevConsumer():
  | (() => void)
  | undefined {
  return backgroundCompactionCallback().registerDev();
}
