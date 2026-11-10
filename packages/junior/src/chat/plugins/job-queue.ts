/**
 * Delivery for plugin jobs: plugin work that runs later, outside any
 * Conversation.
 *
 * Plugins register named jobs and schedule them with `ctx.jobs`. This module
 * owns the signed message, the send path, and the HTTP and local callbacks.
 * Core keeps one topic and one runner for every plugin.
 */
import { createHash } from "node:crypto";
import {
  PLUGIN_JOB_MAX_DELAY_MS,
  type PluginJobScheduler,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { logWarn } from "@/chat/logging";
import { queueCallback } from "@/chat/queue/callback";
import {
  getQueueProvider,
  type QueueConsumer,
  type QueueMessageMetadata,
} from "@/chat/queue/provider";
import {
  QUEUE_SIGNATURE_MAX_AGE_MS,
  signQueueMessage,
  verifyQueueMessage,
} from "@/chat/queue/sign";
import type { AppEventPublisher } from "./agent-hooks";

/** Deploy topic name. Keep stable for Vercel queue wiring. */
export const PLUGIN_JOB_QUEUE_TOPIC = "junior_plugin_jobs";

const PLUGIN_JOB_DEV_CONSUMER_GROUP = "junior_plugin_jobs_dev";
const PLUGIN_JOB_MAX_DELIVERIES = 3;

const pluginJobQueueMessageSchema = z
  .object({
    name: z.string().min(1),
    /** The job payload as JSON text, so the signature covers it. */
    payload: z.string(),
    plugin: z.string().min(1),
  })
  .strict();

/** One plugin job on the queue. */
export type PluginJobQueueMessage = z.output<
  typeof pluginJobQueueMessageSchema
>;

const pluginJobSign = {
  context: "junior.plugin_job_queue.v1",
  schema: pluginJobQueueMessageSchema,
  signatureVersion: "v1" as const,
  parts: (message: PluginJobQueueMessage) => [
    message.plugin,
    message.name,
    message.payload,
  ],
};

function idempotencyKey(plugin: string, name: string, key: string): string {
  const digest = createHash("sha256")
    .update(plugin)
    .update("\0")
    .update(name)
    .update("\0")
    .update(key)
    .digest("hex")
    .slice(0, 32);
  return `plugin-job_${digest}`;
}

/** Create the `ctx.jobs` scheduler for one plugin. */
export function createPluginJobScheduler(
  plugin: PluginRegistration,
): PluginJobScheduler {
  const pluginName = plugin.manifest.name;
  return {
    async schedule(job) {
      if (!plugin.jobs || !Object.hasOwn(plugin.jobs, job.name)) {
        throw new Error(
          `Plugin job "${pluginName}.${job.name}" is not registered`,
        );
      }
      if (
        !Number.isFinite(job.delayMs) ||
        job.delayMs < 0 ||
        job.delayMs > PLUGIN_JOB_MAX_DELAY_MS
      ) {
        throw new Error(
          `Plugin job "${pluginName}.${job.name}" delay must be 0 to ${PLUGIN_JOB_MAX_DELAY_MS} ms`,
        );
      }
      const payload = JSON.stringify(job.payload ?? null);
      await getQueueProvider().send(
        PLUGIN_JOB_QUEUE_TOPIC,
        signQueueMessage(pluginJobSign, {
          name: job.name,
          payload,
          plugin: pluginName,
        }),
        {
          delaySeconds: Math.ceil(job.delayMs / 1000),
          ...(job.key
            ? { idempotencyKey: idempotencyKey(pluginName, job.name, job.key) }
            : undefined),
          retentionSeconds: QUEUE_SIGNATURE_MAX_AGE_MS / 1000,
        },
      );
    },
  };
}

function logPluginJobRejected(
  reason: string,
  metadata: QueueMessageMetadata,
): void {
  logWarn("plugin.job.queue_message.rejected", {
    "app.queue.consumer_group": metadata.consumerGroup,
    "app.queue.delivery_count": metadata.deliveryCount,
    "app.queue.message_id": metadata.messageId,
    "app.queue.reject_reason": reason,
    "app.queue.topic_name": metadata.topicName,
  });
}

function pluginJobCallback(events: AppEventPublisher) {
  return queueCallback<PluginJobQueueMessage>({
    consumerGroup: PLUGIN_JOB_DEV_CONSUMER_GROUP,
    maxDeliveries: PLUGIN_JOB_MAX_DELIVERIES,
    onRejected: logPluginJobRejected,
    // Load the runner on first use, because it imports the plugin registry.
    run: async (message) => {
      const { runPluginJob } = await import("./job-runner");
      await runPluginJob(message, events);
    },
    topic: PLUGIN_JOB_QUEUE_TOPIC,
    verify: (value) => verifyQueueMessage(pluginJobSign, value),
  });
}

/** Create the HTTP callback for plugin jobs. */
export function createVercelPluginJobCallback(
  events: AppEventPublisher,
): (request: Request) => Promise<Response> {
  return pluginJobCallback(events).create();
}

/** Return the queue consumer for plugin jobs, for a pulling queue worker. */
export function pluginJobQueueConsumer(
  events: AppEventPublisher,
): QueueConsumer {
  return pluginJobCallback(events).consumer;
}

/** Register the local-dev consumer for plugin jobs. */
export function registerVercelPluginJobDevConsumer(
  events: AppEventPublisher,
): (() => void) | undefined {
  return pluginJobCallback(events).registerDev();
}
