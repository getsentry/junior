/**
 * Vercel Queue callback for plugin background tasks.
 *
 * The queue payload is a bounded task request. Vercel retries thrown
 * task failures, while malformed payloads are acknowledged without executing
 * plugin code.
 */
import {
  handleCallback,
  registerDevConsumer,
  type MessageMetadata,
  type RetryDirective,
} from "@vercel/queue";
import { logWarn } from "@/chat/logging";
import { runWithTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import { createVercelQueueClient } from "@/chat/vercel-queue-client";
import { processPluginTask } from "./task-runner";
import { PLUGIN_TASK_QUEUE_TOPIC } from "./task-queue";
import {
  verifyPluginTaskQueueMessage,
  type PluginTaskQueueRejectReason,
} from "./task-signing";

export const PLUGIN_TASK_DEV_CONSUMER_GROUP = "junior_plugin_tasks_dev";
const PLUGIN_TASK_MAX_DELIVERIES = 5;

function logPluginTaskQueueMessageRejected(
  reason: PluginTaskQueueRejectReason,
  metadata: MessageMetadata,
): void {
  logWarn(
    "plugin_task_queue_message_rejected",
    {},
    {
      "app.queue.consumer_group": metadata.consumerGroup,
      "app.queue.delivery_count": metadata.deliveryCount,
      "app.queue.message_id": metadata.messageId,
      "app.queue.reject_reason": reason,
      "app.queue.topic_name": metadata.topicName,
    },
    "Plugin task queue message rejected without retry",
  );
}

/** Parse the queue payload and run only the referenced durable task. */
async function handlePluginTaskQueueMessage(
  message: unknown,
  metadata: MessageMetadata,
): Promise<void> {
  const verification = verifyPluginTaskQueueMessage(message);
  if (verification.status === "rejected") {
    logPluginTaskQueueMessageRejected(verification.reason, metadata);
    return;
  }
  if (verification.status === "unavailable") {
    throw new Error(
      `Plugin task queue message verification unavailable: ${verification.reason}`,
    );
  }
  await runWithTurnRequestDeadline(() =>
    processPluginTask(verification.message),
  );
}

/** Bound poison-message retries while preserving normal transient retries. */
function handlePluginTaskQueueRetry(
  _error: unknown,
  metadata: MessageMetadata,
): RetryDirective | undefined {
  if (metadata.deliveryCount >= PLUGIN_TASK_MAX_DELIVERIES) {
    return { acknowledge: true };
  }
  return undefined;
}

/** Create the Vercel Queue push callback for plugin background tasks. */
export function createVercelPluginTaskCallback(): (
  request: Request,
) => Promise<Response> {
  return handleCallback(
    (message, metadata) => handlePluginTaskQueueMessage(message, metadata),
    {
      retry: handlePluginTaskQueueRetry,
    },
  );
}

/** Register the Vercel Queue local-dev consumer for plugin background tasks. */
export function registerVercelPluginTaskDevConsumer():
  | (() => void)
  | undefined {
  if (process.env.NODE_ENV !== "development") {
    return undefined;
  }
  return registerDevConsumer({
    client: createVercelQueueClient(),
    consumerGroup: PLUGIN_TASK_DEV_CONSUMER_GROUP,
    handler: (message, metadata) =>
      handlePluginTaskQueueMessage(message, metadata),
    retry: handlePluginTaskQueueRetry,
    topic: PLUGIN_TASK_QUEUE_TOPIC,
  });
}
