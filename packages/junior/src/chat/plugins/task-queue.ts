/**
 * Delivery for plugin-registered tasks.
 *
 * Plugins register named tasks. This module owns the shared signed message,
 * send path, and HTTP/local callback. Core keeps one topic and one runner.
 */
import { createHash } from "node:crypto";
import type { MessageMetadata } from "@vercel/queue";
import { z } from "zod";
import { logWarn } from "@/chat/logging";
import { queueCallback } from "@/chat/queue/callback";
import {
  QUEUE_SIGNATURE_MAX_AGE_MS,
  signQueueMessage,
  verifyQueueMessage,
} from "@/chat/queue/sign";
import { createVercelQueueClient } from "@/chat/vercel-queue-client";

/** Deploy topic name. Keep stable for Vercel queue wiring. */
export const PLUGIN_TASK_QUEUE_TOPIC = "junior_plugin_tasks";

const PLUGIN_TASK_DEV_CONSUMER_GROUP = "junior_plugin_tasks_dev";
const PLUGIN_TASK_MAX_DELIVERIES = 5;
const PLUGIN_TASK_SIGN_CONTEXT = "junior.plugin_task_queue.v1";
const PLUGIN_TASK_SIGN_VERSION = "v1" as const;

export const pluginTaskParamsSchema = z
  .object({
    conversationId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();

export type PluginTaskParams = z.output<typeof pluginTaskParamsSchema>;

export const pluginTaskQueueMessageSchema = z
  .object({
    name: z.string().min(1),
    params: pluginTaskParamsSchema,
    plugin: z.string().min(1),
  })
  .strict();

export type PluginTaskQueueMessage = z.output<typeof pluginTaskQueueMessageSchema>;

const pluginTaskSign = {
  context: PLUGIN_TASK_SIGN_CONTEXT,
  schema: pluginTaskQueueMessageSchema,
  signatureVersion: PLUGIN_TASK_SIGN_VERSION,
  parts: (message: PluginTaskQueueMessage) => [
    message.plugin,
    message.name,
    message.params.conversationId,
    message.params.sessionId,
  ],
};

/** Build the stable id used for delivery dedupe and tracing. */
export function pluginTaskId(args: {
  name: string;
  params: PluginTaskParams;
  plugin: string;
}): string {
  const digest = createHash("sha256")
    .update(args.plugin)
    .update("\0")
    .update(args.name)
    .update("\0")
    .update(args.params.conversationId)
    .update("\0")
    .update(args.params.sessionId)
    .digest("hex")
    .slice(0, 32);
  return `plugin-task_${digest}`;
}

/** Sign a plugin task message for tests and local checks. */
export function signPluginTaskQueueMessage(
  message: PluginTaskQueueMessage,
  nowMs = Date.now(),
) {
  return signQueueMessage(pluginTaskSign, message, nowMs);
}

function verifyPluginTaskQueueMessage(value: unknown, nowMs = Date.now()) {
  return verifyQueueMessage(pluginTaskSign, value, nowMs);
}

function logPluginTaskQueueMessageRejected(
  reason: string,
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
  return queueCallback<PluginTaskQueueMessage>({
    consumerGroup: PLUGIN_TASK_DEV_CONSUMER_GROUP,
    maxDeliveries: PLUGIN_TASK_MAX_DELIVERIES,
    onRejected: logPluginTaskQueueMessageRejected,
    // Load the runner on first use so this module can send without a cycle.
    run: async (message) => {
      const { processPluginTask } = await import("./task-runner");
      await processPluginTask(message);
    },
    topic: PLUGIN_TASK_QUEUE_TOPIC,
    verify: verifyPluginTaskQueueMessage,
  });
}

/** Send one plugin task through the shared signed delivery path. */
export async function sendVercelPluginTask(message: PluginTaskQueueMessage): Promise<void> {
  await createVercelQueueClient().send(
    PLUGIN_TASK_QUEUE_TOPIC,
    signPluginTaskQueueMessage(message),
    {
      idempotencyKey: pluginTaskId(message),
      retentionSeconds: QUEUE_SIGNATURE_MAX_AGE_MS / 1000,
    },
  );
}

/** Create the HTTP callback for plugin tasks. */
export function createVercelPluginTaskCallback(): (
  request: Request,
) => Promise<Response> {
  return pluginTaskCallback().create();
}

/** Register the local-dev consumer for plugin tasks. */
export function registerVercelPluginTaskDevConsumer(): (() => void) | undefined {
  return pluginTaskCallback().registerDev();
}
