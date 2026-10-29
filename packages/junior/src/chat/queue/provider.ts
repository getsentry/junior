import { vercelQueueProvider } from "@/chat/queue/vercel";

// Module overview: the one place that chooses a queue provider.
//
// Queue code calls `getQueueProvider()` and uses only this contract.
// Provider modules, such as `vercel.ts`, implement it. Only this module
// imports a provider module.

/** Delivery facts that a queue provider passes with each message. */
export interface QueueMessageMetadata {
  consumerGroup: string;
  createdAt: Date;
  /** Starts at 1 for the first delivery. */
  deliveryCount: number;
  messageId: string;
  topicName: string;
}

/** Tells the provider to acknowledge a failed message so it is not retried. */
export interface QueueRetryDirective {
  acknowledge: true;
}

/** Options for one queue send. */
export interface QueueSendOptions {
  /** Wait this many seconds before the first delivery. */
  delaySeconds?: number;
  /** Drop a second send with the same key. */
  idempotencyKey?: string;
  /** Drop the message if it is not delivered within this many seconds. */
  retentionSeconds?: number;
}

/** Result of one queue send. */
export interface QueueSendResult {
  messageId?: string;
}

/** One consumer of one topic. */
export interface QueueConsumer {
  consumerGroup: string;
  handler(payload: unknown, metadata: QueueMessageMetadata): Promise<void>;
  /** Return a directive to stop retries, or `undefined` to retry. */
  retry(
    error: unknown,
    metadata: QueueMessageMetadata,
  ): QueueRetryDirective | undefined;
  topic: string;
  /** Wait this many seconds before a message that is in flight is sent again. */
  visibilityTimeoutSeconds?: number;
}

/** Queue operations that each queue provider implements. */
export interface QueueProvider {
  /** `messaging.system` value on queue spans. */
  readonly messagingSystem: string;
  send(
    topic: string,
    payload: unknown,
    options?: QueueSendOptions,
  ): Promise<QueueSendResult>;
  /** Create the HTTP route that receives pushed messages for one consumer. */
  createCallback(
    consumer: QueueConsumer,
  ): (request: Request) => Promise<Response>;
  /** Receive messages in this process during local development. */
  registerDevConsumer(consumer: QueueConsumer): () => void;
}

/** Return the queue provider for this deployment. */
export function getQueueProvider(): QueueProvider {
  return vercelQueueProvider;
}
