import { createQueueCallbackHandler, getSubagentTaskTopic, getThreadMessageTopic } from "@/chat/queue/client";
import { processQueuedThreadMessage } from "@/chat/queue/process-thread-message";
import { processSubagentTask } from "@/chat/subagent/process-task";
import type { QueuePayload, SubagentTaskPayload, ThreadMessagePayload } from "@/chat/queue/types";
import {
  createRequestContext,
  logError,
  logException,
  setSpanStatus,
  withContext,
  withSpan
} from "@/chat/observability";

const callbackHandler = createQueueCallbackHandler<QueuePayload>(async (message, metadata) => {
  if (metadata.topicName === getThreadMessageTopic()) {
    const payload = {
      ...(message as ThreadMessagePayload),
      queueMessageId: metadata.messageId
    } satisfies ThreadMessagePayload;

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
    return;
  }

  if (metadata.topicName === getSubagentTaskTopic()) {
    const payload = message as SubagentTaskPayload;
    await withSpan(
      "queue.process_subagent_task",
      "queue.process_subagent_task",
      {
        slackThreadId: payload.queueContext.normalizedThreadId,
        slackChannelId: payload.queueContext.thread.channelId,
        slackUserId: payload.queueContext.message.author?.userId
      },
      async () => {
        await processSubagentTask(payload);
      },
      {
        "app.queue.message_id": metadata.messageId,
        "app.queue.delivery_count": metadata.deliveryCount,
        "app.queue.topic": metadata.topicName,
        "app.ai.subagent.call_key": payload.callKey
      }
    );
    return;
  }

  throw new Error(`Unexpected queue topic: ${metadata.topicName}`);
});

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
