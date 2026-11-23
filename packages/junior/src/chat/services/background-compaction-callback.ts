/** Receive background compaction jobs from the queue. */
import { logWarn } from "@/chat/logging";
import { queueCallback } from "@/chat/queue/callback";
import type { QueueMessageMetadata } from "@/chat/queue/provider";
import { processBackgroundCompaction } from "./background-compaction";
import { verifyBackgroundCompactionMessage } from "./background-compaction-queue";

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
    maxDeliveries: BACKGROUND_COMPACTION_MAX_DELIVERIES,
    onRejected: logRejected,
    run: async (message, metadata) =>
      await processBackgroundCompaction(message, {
        enqueuedAtMs: metadata.createdAt.getTime(),
      }),
    verify: verifyBackgroundCompactionMessage,
  });
}

/** Create the HTTP route for background compaction jobs. */
export function createVercelBackgroundCompactionCallback(): (
  request: Request,
) => Promise<Response> {
  return backgroundCompactionCallback().create();
}
