/**
 * Vercel Queue wakeup transport for plugin background tasks.
 *
 * Core signs the bounded task request here. Vercel Queues own pending delivery;
 * plugins receive only the task context after the callback verifies it.
 */
import type { SendOptions, SendResult } from "@vercel/queue";
import { createVercelQueueClient } from "@/chat/vercel-queue-client";
import {
  PLUGIN_TASK_QUEUE_SIGNATURE_MAX_SKEW_MS,
  signPluginTaskQueueMessage,
  type PluginTaskQueueMessage,
} from "./task-queue-signing";

export const DEFAULT_PLUGIN_TASK_QUEUE_TOPIC = "junior_plugin_tasks";
export const PLUGIN_TASK_QUEUE_RETENTION_SECONDS =
  PLUGIN_TASK_QUEUE_SIGNATURE_MAX_SKEW_MS / 1000;

interface QueueSender {
  send<T = unknown>(
    topicName: string,
    payload: T,
    options?: SendOptions,
  ): Promise<SendResult>;
}

export interface PluginTaskQueue {
  send(message: PluginTaskQueueMessage): Promise<void>;
}

export interface VercelPluginTaskQueueOptions {
  client?: QueueSender;
  retentionSeconds?: number;
  topic?: string;
}

let defaultQueue: PluginTaskQueue | undefined;

/** Resolve the Vercel Queue topic used for plugin background tasks. */
export function resolvePluginTaskQueueTopic(
  options: Pick<VercelPluginTaskQueueOptions, "topic"> = {},
): string {
  const topic = options.topic?.trim();
  return (
    topic ||
    process.env.JUNIOR_PLUGIN_TASK_QUEUE_TOPIC?.trim() ||
    DEFAULT_PLUGIN_TASK_QUEUE_TOPIC
  );
}

/** Create the Vercel Queue implementation for plugin background task wakeups. */
export function createVercelPluginTaskQueue(
  options: VercelPluginTaskQueueOptions = {},
): PluginTaskQueue {
  const topic = resolvePluginTaskQueueTopic(options);
  const client = options.client ?? createVercelQueueClient();
  return {
    async send(message) {
      await client.send(topic, signPluginTaskQueueMessage(message), {
        idempotencyKey: message.id,
        retentionSeconds:
          options.retentionSeconds ?? PLUGIN_TASK_QUEUE_RETENTION_SECONDS,
      });
    },
  };
}

/** Return the default production plugin task queue. */
export function getVercelPluginTaskQueue(): PluginTaskQueue {
  defaultQueue ??= createVercelPluginTaskQueue();
  return defaultQueue;
}
