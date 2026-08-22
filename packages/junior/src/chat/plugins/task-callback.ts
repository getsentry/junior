/** Vercel Queue callback for plugin background tasks. */
import type { MessageMetadata } from "@vercel/queue";
import { logWarn } from "@/chat/logging";
import { createQueueJobCallback } from "@/chat/queue-jobs/callback";
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
  logWarn("plugin.task.queue_message.rejected", {
    "app.queue.consumer_group": metadata.consumerGroup,
    "app.queue.delivery_count": metadata.deliveryCount,
    "app.queue.message_id": metadata.messageId,
    "app.queue.reject_reason": reason,
    "app.queue.topic_name": metadata.topicName,
  });
}

function pluginTaskCallback() {
  return createQueueJobCallback({
    consumerGroup: PLUGIN_TASK_DEV_CONSUMER_GROUP,
    maxDeliveries: PLUGIN_TASK_MAX_DELIVERIES,
    onRejected: logPluginTaskQueueMessageRejected,
    run: async (message) => processPluginTask(message),
    topic: PLUGIN_TASK_QUEUE_TOPIC,
    verify: verifyPluginTaskQueueMessage,
  });
}

/** Create the Vercel Queue push callback for plugin background tasks. */
export function createVercelPluginTaskCallback(): (
  request: Request,
) => Promise<Response> {
  return pluginTaskCallback().create();
}

/** Register the Vercel Queue local-dev consumer for plugin background tasks. */
export function registerVercelPluginTaskDevConsumer():
  | (() => void)
  | undefined {
  return pluginTaskCallback().registerDev();
}
