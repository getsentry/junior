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

export const PLUGIN_TASK_QUEUE_TOPIC = "junior_plugin_tasks";
export const PLUGIN_TASK_QUEUE_RETENTION_SECONDS =
  PLUGIN_TASK_QUEUE_SIGNATURE_MAX_SKEW_MS / 1000;

/** Send one plugin task wakeup through Vercel Queues. */
export async function sendVercelPluginTask(
  message: PluginTaskQueueMessage,
): Promise<void> {
  const client = createVercelQueueClient();
  await client.send(
    PLUGIN_TASK_QUEUE_TOPIC,
    signPluginTaskQueueMessage(message),
    {
      idempotencyKey: pluginTaskId(message),
      retentionSeconds: PLUGIN_TASK_QUEUE_RETENTION_SECONDS,
    },
  );
}
