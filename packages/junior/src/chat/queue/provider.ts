import { getAppContext } from "@/app/context";
import type { ChatConfig } from "@/chat/config";
import { createVercelQueueProvider } from "@/chat/queue/vercel";

// Module overview: the one place that names the queue provider.
//
// Queue code uses only this contract. The app context builds the provider.
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

/**
 * Tells the provider what to do with a failed message: acknowledge it so it
 * is not retried, or deliver it again after `afterSeconds`.
 */
export type QueueRetryDirective =
  | { acknowledge: true }
  | { afterSeconds: number };

/** Options for one queue send. */
export interface QueueSendOptions {
  /** Wait this many seconds before the first delivery. */
  delaySeconds?: number | undefined;
  /** Drop a second send with the same key. */
  idempotencyKey?: string | undefined;
  /** Drop the message if it is not delivered within this many seconds. */
  retentionSeconds?: number;
}

/** Result of one queue send. */
export interface QueueSendResult {
  messageId?: string;
}

/** One consumer of one topic. */
export interface QueueConsumer {
  handler(payload: unknown, metadata: QueueMessageMetadata): Promise<void>;
  /** Return a directive, or `undefined` to retry after the visibility timeout. */
  retry(
    error: unknown,
    metadata: QueueMessageMetadata,
  ): QueueRetryDirective | undefined;
  /** Wait this many seconds before a message that is in flight is sent again. */
  visibilityTimeoutSeconds?: number | undefined;
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
}

/** Build the queue provider of an app context from its config. */
export function createQueueProvider(
  config: Pick<ChatConfig, "deployment" | "queue">,
): QueueProvider {
  return createVercelQueueProvider({
    apiUrl: config.queue.apiUrl,
    deploymentId: config.deployment.id,
  });
}

/** Return the queue provider of the app context. */
export function getQueueProvider(): QueueProvider {
  return getAppContext().queue;
}
