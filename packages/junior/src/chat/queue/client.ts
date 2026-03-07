import { handleCallback, send } from "@vercel/queue";

const DEFAULT_TOPIC_NAME = "junior-thread-message";
const SUBAGENT_TASK_TOPIC_NAME = "junior-subagent-task";

const MAX_DELIVERY_ATTEMPTS = 10;

export function getThreadMessageTopic(): string {
  return DEFAULT_TOPIC_NAME;
}

export function getSubagentTaskTopic(): string {
  return SUBAGENT_TASK_TOPIC_NAME;
}

export async function enqueueThreadMessage(
  payload: unknown,
  options?: {
    idempotencyKey?: string;
  }
): Promise<string | undefined> {
  const result = await send(getThreadMessageTopic(), payload, {
    ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {})
  });

  return result.messageId ?? undefined;
}

export async function enqueueSubagentTask(
  payload: unknown,
  options?: {
    idempotencyKey?: string;
  }
): Promise<string | undefined> {
  const result = await send(getSubagentTaskTopic(), payload, {
    ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {})
  });

  return result.messageId ?? undefined;
}

export function createQueueCallbackHandler<T>(
  handler: (message: T, metadata: { messageId: string; deliveryCount: number; topicName: string }) => Promise<void>
): (request: Request) => Promise<Response> {
  return handleCallback<T>(
    async (message, metadata) => {
      await handler(message, {
        messageId: metadata.messageId,
        deliveryCount: metadata.deliveryCount,
        topicName: metadata.topicName
      });
    },
    {
      retry: (_error, metadata) => {
        if (metadata.deliveryCount >= MAX_DELIVERY_ATTEMPTS) {
          return { acknowledge: true };
        }
        const backoffSeconds = Math.min(300, Math.max(5, metadata.deliveryCount * 5));
        return { afterSeconds: backoffSeconds };
      }
    }
  ) as unknown as (request: Request) => Promise<Response>;
}
