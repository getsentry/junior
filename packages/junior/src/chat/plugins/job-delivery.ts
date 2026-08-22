/**
 * Shared delivery pipe for plugin-registered jobs.
 *
 * Plugins register named jobs. This module owns sign, send, retries, and the
 * HTTP/local callback that runs them.
 */
import { defineSignedWork } from "@/chat/queue/job";
import {
  pluginJobId,
  pluginJobMessageSchema,
  type PluginJobMessage,
} from "./job-message";

export const PLUGIN_JOB_TOPIC = "junior_plugin_tasks";

export const pluginJobDelivery = defineSignedWork({
  topic: PLUGIN_JOB_TOPIC,
  consumerGroup: "junior_plugin_tasks_dev",
  maxDeliveries: 5,
  schema: pluginJobMessageSchema,
  context: "junior.plugin_task_queue.v1",
  version: "v1",
  parts: (message) => [
    message.plugin,
    message.name,
    message.params.conversationId,
    message.params.sessionId,
  ],
  id: pluginJobId,
  rejectedLog: "plugin.job.message.rejected",
  // Load the runner on first use so this module can send without a cycle.
  run: async (message) => {
    const { runPluginJob } = await import("./job-runner");
    await runPluginJob(message);
  },
});

/** Compatibility alias while nitro config still names the old topic constant. */
export const PLUGIN_TASK_QUEUE_TOPIC = PLUGIN_JOB_TOPIC;

/** Send one plugin job through the shared delivery pipe. */
export async function sendPluginJob(message: PluginJobMessage): Promise<void> {
  await pluginJobDelivery.send(message);
}

/** Sign a plugin job message for tests and local checks. */
export function signPluginJobMessage(
  message: PluginJobMessage,
  nowMs = Date.now(),
) {
  return pluginJobDelivery.sign(message, nowMs);
}

/** Create the HTTP callback for plugin jobs. */
export function createPluginJobCallback(): (
  request: Request,
) => Promise<Response> {
  return pluginJobDelivery.handle();
}

/** Register the local-dev consumer for plugin jobs. */
export function registerPluginJobDevConsumer(): (() => void) | undefined {
  return pluginJobDelivery.registerDev();
}
