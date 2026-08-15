/**
 * Vercel Queue callback for Workspace snapshot prebuild.
 *
 * The queue payload names one Workspace. Vercel retries thrown task failures,
 * while malformed payloads are acknowledged without executing prebuild work.
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
import { processWorkspacePrebuild } from "./prebuild";
import { WORKSPACE_PREBUILD_QUEUE_TOPIC } from "./prebuild-queue";
import {
  verifyWorkspacePrebuildQueueMessage,
  type WorkspacePrebuildQueueRejectReason,
} from "./prebuild-signing";

export const WORKSPACE_PREBUILD_DEV_CONSUMER_GROUP =
  "junior_workspace_prebuild_dev";
const WORKSPACE_PREBUILD_MAX_DELIVERIES = 5;

function logWorkspacePrebuildQueueMessageRejected(
  reason: WorkspacePrebuildQueueRejectReason,
  metadata: MessageMetadata,
): void {
  logWarn("sandbox.workspace_prebuild.queue_message.rejected", {
    "app.queue.consumer_group": metadata.consumerGroup,
    "app.queue.delivery_count": metadata.deliveryCount,
    "app.queue.message_id": metadata.messageId,
    "app.queue.reject_reason": reason,
    "app.queue.topic_name": metadata.topicName,
  });
}

/** Parse the queue payload and run only the referenced Workspace prebuild. */
async function handleWorkspacePrebuildQueueMessage(
  message: unknown,
  metadata: MessageMetadata,
): Promise<void> {
  const verification = verifyWorkspacePrebuildQueueMessage(message);
  if (verification.status === "rejected") {
    logWorkspacePrebuildQueueMessageRejected(verification.reason, metadata);
    return;
  }
  if (verification.status === "unavailable") {
    throw new Error(
      `Workspace prebuild queue message verification unavailable: ${verification.reason}`,
    );
  }
  await runWithTurnRequestDeadline(() =>
    processWorkspacePrebuild(verification.message),
  );
}

/** Bound poison-message retries while preserving normal transient retries. */
function handleWorkspacePrebuildQueueRetry(
  _error: unknown,
  metadata: MessageMetadata,
): RetryDirective | undefined {
  if (metadata.deliveryCount >= WORKSPACE_PREBUILD_MAX_DELIVERIES) {
    return { acknowledge: true };
  }
  return undefined;
}

/** Create the Vercel Queue push callback for Workspace snapshot prebuild. */
export function createVercelWorkspacePrebuildCallback(): (
  request: Request,
) => Promise<Response> {
  return handleCallback(
    (message, metadata) =>
      handleWorkspacePrebuildQueueMessage(message, metadata),
    {
      retry: handleWorkspacePrebuildQueueRetry,
    },
  );
}

/** Register the Vercel Queue local-dev consumer for Workspace snapshot prebuild. */
export function registerVercelWorkspacePrebuildDevConsumer():
  | (() => void)
  | undefined {
  if (process.env.NODE_ENV !== "development") {
    return undefined;
  }
  return registerDevConsumer({
    client: createVercelQueueClient(),
    consumerGroup: WORKSPACE_PREBUILD_DEV_CONSUMER_GROUP,
    handler: (message, metadata) =>
      handleWorkspacePrebuildQueueMessage(message, metadata),
    retry: handleWorkspacePrebuildQueueRetry,
    topic: WORKSPACE_PREBUILD_QUEUE_TOPIC,
  });
}
