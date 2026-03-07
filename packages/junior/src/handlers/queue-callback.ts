import { createQueueCallbackHandler, getThreadMessageTopic } from "@/chat/queue/client";
import { processQueuedThreadMessage } from "@/chat/queue/process-thread-message";
import type { ThreadMessagePayload } from "@/chat/queue/types";
import {
  createRequestContext,
  logError,
  logException,
  setSpanStatus,
  withContext,
  withSpan
} from "@/chat/observability";

const callbackHandler = createQueueCallbackHandler<ThreadMessagePayload>(async (message, metadata) => {
  const payload = {
    ...message,
    queueMessageId: metadata.messageId
  } satisfies ThreadMessagePayload;

  if (metadata.topicName !== getThreadMessageTopic()) {
    throw new Error(`Unexpected queue topic: ${metadata.topicName}`);
  }

  await withSpan(
    "queue.process_message",
    "queue.process_message",
    {
      slackThreadId: payload.normalizedThreadId,
      slackChannelId: payload.thread.channelId,
      slackUserId: payload.message.author?.userId
    },
    async () => {
      await processQueuedThreadMessage(payload);
    },
    {
      "messaging.message.id": payload.message.id,
      "app.queue.message_kind": payload.kind,
      "app.queue.message_id": payload.queueMessageId,
      "app.queue.delivery_count": metadata.deliveryCount,
      "app.queue.topic": metadata.topicName
    }
  );
});

/**
 * Handles queue callback POST requests for asynchronous thread processing.
 */
export async function POST(request: Request): Promise<Response> {
  const requestContext = createRequestContext(request, { platform: "queue" });

  return withContext(requestContext, async () => {
    try {
      const response = await callbackHandler(request);
      setSpanStatus(response.status >= 500 ? "error" : "ok");
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(
        "queue_callback_failed",
        {},
        {
          "error.message": message
        },
        "Queue callback processing failed"
      );
      logException(error, "queue_callback_failed");
      throw error;
    }
  });
}
