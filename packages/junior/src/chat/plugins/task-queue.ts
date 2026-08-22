/**
 * Plugin background task queue.
 *
 * The message is the work unit. Vercel Queue delivers it. The runner owns the
 * actual plugin work.
 */
import { queueJob } from "@/chat/queue/job";
import {
  pluginTaskId,
  pluginTaskQueueMessageSchema,
  type PluginTaskQueueMessage,
} from "./task-message";

export const PLUGIN_TASK_QUEUE_TOPIC = "junior_plugin_tasks";

export const pluginTasks = queueJob({
  topic: PLUGIN_TASK_QUEUE_TOPIC,
  consumerGroup: "junior_plugin_tasks_dev",
  maxDeliveries: 5,
  schema: pluginTaskQueueMessageSchema,
  context: "junior.plugin_task_queue.v1",
  version: "v1",
  parts: (message) => [
    message.plugin,
    message.name,
    message.params.conversationId,
    message.params.sessionId,
  ],
  id: pluginTaskId,
  rejectedLog: "plugin.task.queue_message.rejected",
  // Load the runner on first use so this module can send without a cycle.
  run: async (message) => {
    const { processPluginTask } = await import("./task-runner");
    await processPluginTask(message);
  },
});

/** Send one plugin task through Vercel Queue. */
export async function sendVercelPluginTask(
  message: PluginTaskQueueMessage,
): Promise<void> {
  await pluginTasks.send(message);
}

/** Sign a plugin task message for tests and local checks. */
export function signPluginTaskQueueMessage(
  message: PluginTaskQueueMessage,
  nowMs = Date.now(),
) {
  return pluginTasks.sign(message, nowMs);
}

/** Create the HTTP callback for plugin tasks. */
export function createVercelPluginTaskCallback(): (
  request: Request,
) => Promise<Response> {
  return pluginTasks.handle();
}

/** Register the local-dev consumer for plugin tasks. */
export function registerVercelPluginTaskDevConsumer():
  | (() => void)
  | undefined {
  return pluginTasks.registerDev();
}
