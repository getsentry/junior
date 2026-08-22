/**
 * Delivery for plugin-registered jobs.
 *
 * Plugins register named jobs. This module owns the shared signed message,
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
export const PLUGIN_JOB_TOPIC = "junior_plugin_tasks";

const PLUGIN_JOB_CONSUMER_GROUP = "junior_plugin_tasks_dev";
const PLUGIN_JOB_MAX_DELIVERIES = 5;
const PLUGIN_JOB_SIGN_CONTEXT = "junior.plugin_task_queue.v1";
const PLUGIN_JOB_SIGN_VERSION = "v1" as const;

export const pluginJobParamsSchema = z
  .object({
    conversationId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();

export type PluginJobParams = z.output<typeof pluginJobParamsSchema>;

export const pluginJobMessageSchema = z
  .object({
    name: z.string().min(1),
    params: pluginJobParamsSchema,
    plugin: z.string().min(1),
  })
  .strict();

export type PluginJobMessage = z.output<typeof pluginJobMessageSchema>;

const pluginJobSign = {
  context: PLUGIN_JOB_SIGN_CONTEXT,
  schema: pluginJobMessageSchema,
  signatureVersion: PLUGIN_JOB_SIGN_VERSION,
  parts: (message: PluginJobMessage) => [
    message.plugin,
    message.name,
    message.params.conversationId,
    message.params.sessionId,
  ],
};

/** Build the stable id used for delivery dedupe and tracing. */
export function pluginJobId(args: {
  name: string;
  params: PluginJobParams;
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
  return `plugin-job_${digest}`;
}

/** Sign a plugin job message for tests and local checks. */
export function signPluginJobMessage(
  message: PluginJobMessage,
  nowMs = Date.now(),
) {
  return signQueueMessage(pluginJobSign, message, nowMs);
}

function verifyPluginJobMessage(value: unknown, nowMs = Date.now()) {
  return verifyQueueMessage(pluginJobSign, value, nowMs);
}

function logPluginJobMessageRejected(
  reason: string,
  metadata: MessageMetadata,
): void {
  logWarn("plugin.job.message.rejected", {
    "app.queue.consumer_group": metadata.consumerGroup,
    "app.queue.delivery_count": metadata.deliveryCount,
    "app.queue.message_id": metadata.messageId,
    "app.queue.reject_reason": reason,
    "app.queue.topic_name": metadata.topicName,
  });
}

function pluginJobCallback() {
  return queueCallback<PluginJobMessage>({
    consumerGroup: PLUGIN_JOB_CONSUMER_GROUP,
    maxDeliveries: PLUGIN_JOB_MAX_DELIVERIES,
    onRejected: logPluginJobMessageRejected,
    // Load the runner on first use so this module can send without a cycle.
    run: async (message) => {
      const { runPluginJob } = await import("./job-runner");
      await runPluginJob(message);
    },
    topic: PLUGIN_JOB_TOPIC,
    verify: verifyPluginJobMessage,
  });
}

/** Send one plugin job through the shared signed delivery path. */
export async function sendPluginJob(message: PluginJobMessage): Promise<void> {
  await createVercelQueueClient().send(
    PLUGIN_JOB_TOPIC,
    signPluginJobMessage(message),
    {
      idempotencyKey: pluginJobId(message),
      retentionSeconds: QUEUE_SIGNATURE_MAX_AGE_MS / 1000,
    },
  );
}

/** Create the HTTP callback for plugin jobs. */
export function createPluginJobCallback(): (
  request: Request,
) => Promise<Response> {
  return pluginJobCallback().create();
}

/** Register the local-dev consumer for plugin jobs. */
export function registerPluginJobDevConsumer(): (() => void) | undefined {
  return pluginJobCallback().registerDev();
}
