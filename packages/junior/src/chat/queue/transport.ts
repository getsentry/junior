import { handleCallback, send } from "@vercel/queue";

export interface QueueCallbackMetadata {
  deliveryCount: number;
  messageId: string;
  topicName: string;
}

export type QueueRetryDecision =
  | { acknowledge: true }
  | { afterSeconds: number };

export async function sendQueueMessage(
  topicName: string,
  payload: unknown,
  options?: {
    idempotencyKey?: string;
  },
): Promise<string | undefined> {
  const result = await send(topicName, payload, {
    ...(options?.idempotencyKey
      ? { idempotencyKey: options.idempotencyKey }
      : {}),
  });

  return result.messageId ?? undefined;
}

export function createTransportCallbackHandler<T>(
  handler: (message: T, metadata: QueueCallbackMetadata) => Promise<void>,
  options?: {
    retry?: (
      error: unknown,
      metadata: QueueCallbackMetadata,
    ) => QueueRetryDecision | void;
  },
): (request: Request) => Promise<Response> {
  return handleCallback<T>(
    async (message, metadata) => {
      await handler(message, {
        messageId: metadata.messageId,
        deliveryCount: metadata.deliveryCount,
        topicName: metadata.topicName,
      });
    },
    options
      ? {
          retry: options.retry
            ? (error, metadata) =>
                options.retry?.(error, {
                  messageId: metadata.messageId,
                  deliveryCount: metadata.deliveryCount,
                  topicName: metadata.topicName,
                })
            : undefined,
        }
      : undefined,
  ) as unknown as (request: Request) => Promise<Response>;
}
