/** Shared queue callback wiring for signed messages. */
import {
  getQueueProvider,
  type QueueConsumer,
  type QueueMessageMetadata,
  type QueueRetryDirective,
} from "@/chat/queue/provider";
import { runWithTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import type { QueueRejectReason, QueueVerifyResult } from "./sign";

export interface QueueCallbackOptions<Message> {
  consumerGroup: string;
  /** Use `null` when durable state already owns the attempt limit. */
  maxDeliveries: number | null;
  onRejected(
    reason: QueueRejectReason | string,
    metadata: QueueMessageMetadata,
    error?: unknown,
  ): void;
  permanentError?: (error: unknown) => string | undefined;
  run(message: Message, metadata: QueueMessageMetadata): Promise<void>;
  /**
   * Acknowledge without checking or running the message.
   * Use for kill switches that must not depend on signing secrets.
   */
  skip?: (metadata: QueueMessageMetadata) => boolean;
  topic: string;
  verify(value: unknown): QueueVerifyResult<Message>;
  visibilityTimeoutSeconds?: number;
}

/** Build the HTTP callback and local-dev consumer for one signed queue. */
export function queueCallback<Message>(options: QueueCallbackOptions<Message>) {
  const consume = async (
    message: Message,
    metadata: QueueMessageMetadata,
  ): Promise<void> => {
    if (options.skip?.(metadata)) {
      return;
    }
    try {
      await runWithTurnRequestDeadline(() => options.run(message, metadata));
    } catch (error) {
      const reason = options.permanentError?.(error);
      if (!reason) {
        throw error;
      }
      options.onRejected(reason, metadata, error);
    }
  };

  const handler = async (
    value: unknown,
    metadata: QueueMessageMetadata,
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
    await consume(checked.message, metadata);
  };

  const retry = (
    error: unknown,
    metadata: QueueMessageMetadata,
  ): QueueRetryDirective | undefined => {
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

  const consumer: QueueConsumer = {
    consumerGroup: options.consumerGroup,
    handler,
    retry,
    topic: options.topic,
    visibilityTimeoutSeconds: options.visibilityTimeoutSeconds,
  };

  return {
    /** Run a message that an in-process queue already trusts. */
    consume,
    create: () => getQueueProvider().createCallback(consumer),
    registerDev: () => {
      if (process.env.NODE_ENV !== "development") {
        return undefined;
      }
      return getQueueProvider().registerDevConsumer(consumer);
    },
  };
}
