/** Shared verification, retry, and local delivery rules for Vercel Queue jobs. */
import {
  handleCallback,
  registerDevConsumer,
  type MessageMetadata,
  type RetryDirective,
} from "@vercel/queue";
import { runWithTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import { createVercelQueueClient } from "@/chat/vercel-queue-client";
import type {
  QueueMessageRejectReason,
  QueueMessageVerificationResult,
} from "./message";

interface QueueJobCallbackOptions<Message, PermanentReason extends string> {
  consumerGroup: string;
  /** Null keeps provider redelivery unbounded. Use only when durable state owns the limit. */
  maxDeliveries: number | null;
  onRejected(
    reason: QueueMessageRejectReason | PermanentReason,
    metadata: MessageMetadata,
    error?: unknown,
  ): void;
  permanentError?: (error: unknown) => PermanentReason | undefined;
  run(message: Message, metadata: MessageMetadata): Promise<void>;
  topic: string;
  verify(value: unknown): QueueMessageVerificationResult<Message>;
  visibilityTimeoutSeconds?: number;
}

interface QueueJobCallback {
  create(): (request: Request) => Promise<Response>;
  registerDev(): (() => void) | undefined;
}

/** Create one queue callback with explicit verification and delivery limits. */
export function createQueueJobCallback<
  Message,
  PermanentReason extends string = never,
>(
  options: QueueJobCallbackOptions<Message, PermanentReason>,
): QueueJobCallback {
  const handler = async (
    value: unknown,
    metadata: MessageMetadata,
  ): Promise<void> => {
    const verification = options.verify(value);
    if (verification.status === "rejected") {
      options.onRejected(verification.reason, metadata);
      return;
    }
    if (verification.status === "unavailable") {
      throw new Error(
        `Queue message verification unavailable: ${verification.reason}`,
      );
    }
    try {
      await runWithTurnRequestDeadline(() =>
        options.run(verification.message, metadata),
      );
    } catch (error) {
      const reason = options.permanentError?.(error);
      if (!reason) {
        throw error;
      }
      options.onRejected(reason, metadata, error);
    }
  };

  const retry = (
    error: unknown,
    metadata: MessageMetadata,
  ): RetryDirective | undefined => {
    const reason = options.permanentError?.(error);
    if (reason) {
      options.onRejected(reason, metadata, error);
      return { acknowledge: true };
    }
    if (
      options.maxDeliveries !== null &&
      metadata.deliveryCount >= options.maxDeliveries
    ) {
      return { acknowledge: true };
    }
    return undefined;
  };

  return {
    create: () =>
      handleCallback(handler, {
        retry,
        ...(options.visibilityTimeoutSeconds === undefined
          ? {}
          : { visibilityTimeoutSeconds: options.visibilityTimeoutSeconds }),
      }),
    registerDev: () => {
      if (process.env.NODE_ENV !== "development") {
        return undefined;
      }
      return registerDevConsumer({
        client: createVercelQueueClient(),
        consumerGroup: options.consumerGroup,
        handler,
        retry,
        topic: options.topic,
        ...(options.visibilityTimeoutSeconds === undefined
          ? {}
          : { visibilityTimeoutSeconds: options.visibilityTimeoutSeconds }),
      });
    },
  };
}
