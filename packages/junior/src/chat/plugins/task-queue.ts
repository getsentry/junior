/**
 * Delivery for plugin-registered tasks.
 *
 * Plugins register named tasks. This module owns the shared signed message,
 * send path, and HTTP/local callback. Core keeps one topic and one runner.
 */
import { createHash } from "node:crypto";
import * as z from "zod";
import type { ShowInboxItem } from "@/chat/inbox-items/changes";
import type { AppEventPublisher } from "@/chat/plugins/agent-hooks";
import type { SendPluginTask } from "./task-runner";
import { logWarn } from "@/chat/logging";
import { queueCallback } from "@/chat/queue/callback";
import {
  getQueueProvider,
  type QueueMessageMetadata,
} from "@/chat/queue/provider";
import {
  QUEUE_SIGNATURE_MAX_AGE_MS,
  signQueueMessage,
  verifyQueueMessage,
} from "@/chat/queue/sign";
import { PLUGIN_TASK_QUEUE_TOPIC } from "@/chat/queue/topics";

/** Options for one plugin task send. */
export interface PluginTaskSendOptions {
  /** Seconds before the first delivery of a started task. */
  delaySeconds?: number | undefined;
  /** Queue dedupe key of a started task. A session task derives its own. */
  idempotencyKey?: string;
}

/** Queue deliveries of one plugin task before it stops. */
export const PLUGIN_TASK_MAX_DELIVERIES = 5;
const PLUGIN_TASK_SIGN_CONTEXT = "junior.plugin_task_queue.v1";
const PLUGIN_TASK_SIGN_VERSION = "v1" as const;

export const pluginTaskParamsSchema = z
  .object({
    conversationId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();

export type PluginTaskParams = z.output<typeof pluginTaskParamsSchema>;

const sessionPluginTaskMessageSchema = z
  .object({
    name: z.string().min(1),
    params: pluginTaskParamsSchema,
    plugin: z.string().min(1),
  })
  .strict();

export type SessionPluginTaskMessage = z.output<
  typeof sessionPluginTaskMessageSchema
>;

/** A task that a plugin started with `tasks.start`, with its JSON payload. */
const startedPluginTaskMessageSchema = z
  .object({
    name: z.string().min(1),
    payload: z.json(),
    plugin: z.string().min(1),
  })
  .strict();

export type StartedPluginTaskMessage = z.output<
  typeof startedPluginTaskMessageSchema
>;

export const pluginTaskQueueMessageSchema = z.union([
  sessionPluginTaskMessageSchema,
  startedPluginTaskMessageSchema,
]);

export type PluginTaskQueueMessage = z.output<
  typeof pluginTaskQueueMessageSchema
>;

const pluginTaskSign = {
  context: PLUGIN_TASK_SIGN_CONTEXT,
  schema: pluginTaskQueueMessageSchema,
  signatureVersion: PLUGIN_TASK_SIGN_VERSION,
  // JSON text has no raw null byte, so the parts of a started task cannot
  // match the parts of a session task message.
  parts: (message: PluginTaskQueueMessage) =>
    "payload" in message
      ? [message.plugin, message.name, JSON.stringify(message.payload)]
      : [
          message.plugin,
          message.name,
          message.params.conversationId,
          message.params.sessionId,
        ],
};

/**
 * Seconds before the queue delivers a failed plugin task again: 30, 60, 120,
 * then 240. One fixed backoff for every task.
 */
export function pluginTaskRetryDelaySeconds(deliveryCount: number): number {
  return 30 * 2 ** (Math.min(Math.max(deliveryCount, 1), 4) - 1);
}

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

/**
 * Build the queue idempotency key of a started task. Vercel Queues accepts
 * at most 256 characters, so send a hash, never the plugin's key.
 */
export function startedPluginTaskIdempotencyKey(args: {
  key: string;
  name: string;
  plugin: string;
}): string {
  const digest = createHash("sha256")
    .update(args.plugin)
    .update("\0")
    .update(args.name)
    .update("\0")
    .update(args.key)
    .digest("hex");
  return `plugin-task-start_${digest}`;
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
  metadata: QueueMessageMetadata,
): void {
  logWarn("plugin.task.queue_message.rejected", {
    "app.queue.consumer_group": metadata.consumerGroup,
    "app.queue.delivery_count": metadata.deliveryCount,
    "app.queue.message_id": metadata.messageId,
    "app.queue.reject_reason": reason,
    "app.queue.topic_name": metadata.topicName,
  });
}

interface PluginTaskCallbackOptions {
  events?: AppEventPublisher;
  sendPluginTask?: SendPluginTask;
  showInboxItem?: ShowInboxItem;
}

function pluginTaskCallback(options: PluginTaskCallbackOptions) {
  return queueCallback<PluginTaskQueueMessage>({
    maxDeliveries: PLUGIN_TASK_MAX_DELIVERIES,
    onRejected: logPluginTaskQueueMessageRejected,
    retryDelaySeconds: pluginTaskRetryDelaySeconds,
    // Load the runner on first use so this module can send without a cycle.
    run: async (message, metadata) => {
      const { processPluginTask } = await import("./task-runner");
      await processPluginTask(message, {
        ...options,
        deliveryCount: metadata.deliveryCount,
      });
    },
    verify: verifyPluginTaskQueueMessage,
  });
}

/** Send one plugin task through the shared signed delivery path. */
export async function sendVercelPluginTask(
  message: PluginTaskQueueMessage,
  options: PluginTaskSendOptions = {},
): Promise<void> {
  await getQueueProvider().send(
    PLUGIN_TASK_QUEUE_TOPIC,
    signPluginTaskQueueMessage(message),
    {
      delaySeconds: options.delaySeconds,
      idempotencyKey:
        "params" in message ? pluginTaskId(message) : options.idempotencyKey,
      retentionSeconds: QUEUE_SIGNATURE_MAX_AGE_MS / 1000,
    },
  );
}

/** Create the HTTP callback for plugin tasks. */
export function createVercelPluginTaskCallback(
  options: PluginTaskCallbackOptions = {},
): (request: Request) => Promise<Response> {
  return pluginTaskCallback(options).create();
}
