/**
 * Vercel Queue callback for plugin background tasks.
 *
 * The queue payload is a signed bounded task request. Vercel retries thrown
 * task failures, while malformed envelopes are acknowledged without executing
 * plugin code.
 */
import {
  handleCallback,
  registerDevConsumer,
  type MessageMetadata,
  type RetryDirective,
} from "@vercel/queue";
import { logWarn } from "@/chat/logging";
import { runWithTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import { createVercelQueueClient } from "@/chat/vercel-queue-client";
import { processPluginTask } from "./task-runner";
import { resolvePluginTaskQueueTopic } from "./task-queue";
import {
  verifyPluginTaskQueueMessage,
  type PluginTaskQueueMessage,
} from "./task-queue-signing";

export const PLUGIN_TASK_DEV_CONSUMER_GROUP = "junior_plugin_tasks_dev";

export interface VercelPluginTaskCallbackOptions {
  /** Task runner port used by callback tests and local dev wiring. */
  processTask?: (message: PluginTaskQueueMessage) => Promise<void> | void;
  topic?: string;
  visibilityTimeoutSeconds?: number;
}

function logPluginTaskQueueMessageRejected(
  reason: "expired" | "malformed" | "signature_mismatch" | "id_mismatch",
  metadata: MessageMetadata,
): void {
  logWarn(
    "plugin_task_queue_message_rejected",
    {},
    {
      "app.queue.consumer_group": metadata.consumerGroup,
      "app.queue.delivery_count": metadata.deliveryCount,
      "app.queue.message_id": metadata.messageId,
      "app.queue.reject_reason": reason,
      "app.queue.topic_name": metadata.topicName,
    },
    "Plugin task queue message rejected without retry",
  );
}

/** Verify the signed task envelope and run only the referenced durable task. */
async function handlePluginTaskQueueMessage(
  message: unknown,
  metadata: MessageMetadata,
  processTask: (
    message: PluginTaskQueueMessage,
  ) => Promise<void> | void = processPluginTask,
): Promise<void> {
  const verification = verifyPluginTaskQueueMessage(message);
  if (verification.status === "rejected") {
    logPluginTaskQueueMessageRejected(verification.reason, metadata);
    return;
  }
  if (verification.status === "unavailable") {
    throw new Error(
      `Plugin task queue message verification unavailable: ${verification.reason}`,
    );
  }
  await runWithTurnRequestDeadline(() => processTask(verification.message));
}

/** Let Vercel retry thrown task failures; rejected envelopes are acked above. */
function handlePluginTaskQueueRetry(): RetryDirective | undefined {
  return undefined;
}

/** Create the Vercel Queue push callback for plugin background tasks. */
export function createVercelPluginTaskCallback(
  options: VercelPluginTaskCallbackOptions = {},
): (request: Request) => Promise<Response> {
  return handleCallback(
    (message, metadata) =>
      handlePluginTaskQueueMessage(message, metadata, options.processTask),
    {
      retry: handlePluginTaskQueueRetry,
      visibilityTimeoutSeconds: options.visibilityTimeoutSeconds,
    },
  );
}

/** Register the Vercel Queue local-dev consumer for plugin background tasks. */
export function registerVercelPluginTaskDevConsumer(
  options: VercelPluginTaskCallbackOptions = {},
): (() => void) | undefined {
  if (process.env.NODE_ENV !== "development") {
    return undefined;
  }
  return registerDevConsumer({
    client: createVercelQueueClient(),
    consumerGroup: PLUGIN_TASK_DEV_CONSUMER_GROUP,
    handler: (message, metadata) =>
      handlePluginTaskQueueMessage(message, metadata, options.processTask),
    retry: handlePluginTaskQueueRetry,
    topic: resolvePluginTaskQueueTopic(options),
    visibilityTimeoutSeconds: options.visibilityTimeoutSeconds,
  });
}
