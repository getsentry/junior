/** Shared Vercel Queue callback wiring for signed jobs. */
import {
  handleCallback,
  registerDevConsumer,
  type MessageMetadata,
  type RetryDirective,
} from "@vercel/queue";
import { runWithTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import { createVercelQueueClient } from "@/chat/vercel-queue-client";
import type { QueueRejectReason, QueueVerifyResult } from "./sign";

export interface QueueCallbackOptions<Message> {
  consumerGroup: string;
  /** Use `null` when durable state already owns the attempt limit. */
  maxDeliveries: number | null;
  onRejected(
    reason: QueueRejectReason | string,
    metadata: MessageMetadata,
    error?: unknown,
  ): void;
  permanentError?: (error: unknown) => string | undefined;
  run(message: Message, metadata: MessageMetadata): Promise<void>;
  /**
   * Acknowledge without checking or running the message.
   * Use for kill switches that must not depend on signing secrets.
   */
  skip?: (metadata: MessageMetadata) => boolean;
  topic: string;
  verify(value: unknown): QueueVerifyResult<Message>;
  visibilityTimeoutSeconds?: number;
}

/** Build the HTTP callback and local-dev consumer for one queue job. */
export function queueCallback<Message>(options: QueueCallbackOptions<Message>) {
  const handler = async (
    value: unknown,
    metadata: MessageMetadata,
  ): Promise<void> => {
    if (options.skip?.(metadata)) {
      return;
    }
    const checked = options.verify(value);
    if (checked.status === "rejected") {
      options.onRejected(checked.reason, metadata);
      return;
    }
    if (checked.status === "unavailable") {
      throw new Error(
        `Queue message verification unavailable: ${checked.reason}`,
      );
    }
    try {
      await runWithTurnRequestDeadline(() =>
        options.run(checked.message, metadata),
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

  const visibility =
    options.visibilityTimeoutSeconds === undefined
      ? {}
      : { visibilityTimeoutSeconds: options.visibilityTimeoutSeconds };

  return {
    create: () => handleCallback(handler, { retry, ...visibility }),
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
        ...visibility,
      });
    },
  };
}
