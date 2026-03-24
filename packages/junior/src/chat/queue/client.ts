import { isDeferredThreadMessageError } from "@/chat/queue/errors";
import {
  createTransportCallbackHandler,
  sendQueueMessage,
  type QueueCallbackMetadata,
} from "@/chat/queue/transport";

const THREAD_MESSAGE_TOPIC = "junior-thread-message";

const MAX_DELIVERY_ATTEMPTS = 10;
const THREAD_LOCK_RETRY_MAX_SECONDS = 30;
const ACTIVE_TURN_RETRY_MAX_SECONDS = 300;

export function getThreadMessageTopic(): string {
  return THREAD_MESSAGE_TOPIC;
}

export async function enqueueThreadMessage(
  payload: unknown,
  options?: {
    idempotencyKey?: string;
  },
): Promise<string | undefined> {
  return await sendQueueMessage(getThreadMessageTopic(), payload, options);
}

export function createQueueCallbackHandler<T>(
  handler: (message: T, metadata: QueueCallbackMetadata) => Promise<void>,
): (request: Request) => Promise<Response> {
  return createTransportCallbackHandler<T>(handler, {
    retry: (error, metadata) => {
      if (isDeferredThreadMessageError(error, "thread_locked")) {
        return {
          afterSeconds: Math.min(
            THREAD_LOCK_RETRY_MAX_SECONDS,
            Math.max(5, metadata.deliveryCount * 5),
          ),
        };
      }
      if (isDeferredThreadMessageError(error, "active_turn")) {
        return {
          afterSeconds: Math.min(
            ACTIVE_TURN_RETRY_MAX_SECONDS,
            Math.max(30, metadata.deliveryCount * 30),
          ),
        };
      }
      if (metadata.deliveryCount >= MAX_DELIVERY_ATTEMPTS) {
        return { acknowledge: true };
      }
      const backoffSeconds = Math.min(
        300,
        Math.max(5, metadata.deliveryCount * 5),
      );
      return { afterSeconds: backoffSeconds };
    },
  });
}
