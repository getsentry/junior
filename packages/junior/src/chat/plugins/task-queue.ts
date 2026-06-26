/**
 * Vercel Queue wakeup transport for plugin background tasks.
 *
 * Vercel Queues own pending delivery; plugins receive only the task context
 * after the callback parses the bounded task request.
 */
import { createVercelQueueClient } from "@/chat/vercel-queue-client";
import { pluginTaskId, type PluginTaskQueueMessage } from "./task-message";
import {
  PLUGIN_TASK_QUEUE_SIGNATURE_MAX_SKEW_MS,
  signPluginTaskQueueMessage,
} from "./task-signing";

export const DEFAULT_PLUGIN_TASK_QUEUE_TOPIC = "junior_plugin_tasks";
export const PLUGIN_TASK_QUEUE_RETENTION_SECONDS =
  PLUGIN_TASK_QUEUE_SIGNATURE_MAX_SKEW_MS / 1000;

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

/** Send one plugin task wakeup through Vercel Queues. */
export async function sendVercelPluginTask(
  message: PluginTaskQueueMessage,
): Promise<void> {
  const topic = resolvePluginTaskQueueTopic();
  const client = createVercelQueueClient();
  await client.send(topic, signPluginTaskQueueMessage(message), {
    idempotencyKey: pluginTaskId(message),
    retentionSeconds: PLUGIN_TASK_QUEUE_RETENTION_SECONDS,
  });
}
