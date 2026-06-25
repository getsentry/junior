/**
 * Vercel Queue wakeup transport for plugin background tasks.
 *
 * Vercel Queues own pending delivery; plugins receive only the task context
 * after the callback parses the bounded task request.
 */
import { createVercelQueueClient } from "@/chat/vercel-queue-client";
import { pluginTaskId, type PluginTaskQueueMessage } from "./task-message";

export const DEFAULT_PLUGIN_TASK_QUEUE_TOPIC = "junior_plugin_tasks";

export interface PluginTaskQueue {
  send(message: PluginTaskQueueMessage): Promise<void>;
}

let defaultQueue: PluginTaskQueue | undefined;

/** Resolve the Vercel Queue topic used for plugin background tasks. */
export function resolvePluginTaskQueueTopic(
  options: { topic?: string } = {},
): string {
  const topic = options.topic?.trim();
  return (
    topic ||
    process.env.JUNIOR_PLUGIN_TASK_QUEUE_TOPIC?.trim() ||
    DEFAULT_PLUGIN_TASK_QUEUE_TOPIC
  );
}

function createVercelPluginTaskQueue(): PluginTaskQueue {
  const topic = resolvePluginTaskQueueTopic();
  const client = createVercelQueueClient();
  return {
    async send(message) {
      await client.send(topic, message, {
        idempotencyKey: pluginTaskId(message),
      });
    },
  };
}

/** Return the default production plugin task queue. */
export function getVercelPluginTaskQueue(): PluginTaskQueue {
  defaultQueue ??= createVercelPluginTaskQueue();
  return defaultQueue;
}
