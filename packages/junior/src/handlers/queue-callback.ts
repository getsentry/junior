import { slackRuntime } from "@/chat/app/production";
import {
  createQueueCallbackHandler,
  getThreadMessageTopic,
} from "@/chat/queue/client";
import { processQueuedThreadMessage } from "@/chat/queue/process-thread-message";
import { createThreadMessageDispatcher } from "@/chat/queue/thread-message-dispatcher";
import type { ThreadMessagePayload } from "@/chat/queue/types";
import {
  createRequestContext,
  logError,
  logException,
  logInfo,
  setSpanStatus,
  withContext,
  withSpan,
} from "@/chat/observability";

/**
 * Queue callback contract for `@sentry/junior`.
 *
 * Queue providers need a fixed callback URL (`/api/queue/callback`) that is
 * configured out-of-band. A catch-all route is not sufficient as the canonical
 * production endpoint because providers target an exact path.
 */
const dispatch = createThreadMessageDispatcher({
  runtime: slackRuntime,
});

const callbackHandler = createQueueCallbackHandler<ThreadMessagePayload>(
  async (message, metadata) => {
    if (metadata.topicName === getThreadMessageTopic()) {
      const payload = {
        ...message,
        queueMessageId: metadata.messageId,
      } satisfies ThreadMessagePayload;

      logInfo(
        "queue_callback_received",
        {
          slackThreadId: payload.normalizedThreadId,
          slackChannelId: payload.thread.channelId,
          slackUserId: payload.message.author?.userId,
        },
        {
          "messaging.message.id": payload.message.id,
          "app.queue.message_kind": payload.kind,
          "app.queue.message_id": payload.queueMessageId,
          "app.queue.delivery_count": metadata.deliveryCount,
          "app.queue.topic": metadata.topicName,
        },
        "Received queue callback payload",
      );

      await withSpan(
        "queue.process_message",
        "queue.process_message",
        {
          slackThreadId: payload.normalizedThreadId,
          slackChannelId: payload.thread.channelId,
          slackUserId: payload.message.author?.userId,
        },
        async () => {
          await processQueuedThreadMessage(payload, {
            dispatch,
          });
        },
        {
          "messaging.message.id": payload.message.id,
          "app.queue.message_kind": payload.kind,
          "app.queue.message_id": payload.queueMessageId,
          "app.queue.delivery_count": metadata.deliveryCount,
          "app.queue.topic": metadata.topicName,
        },
      );
      return;
    }

    throw new Error(`Unexpected queue topic: ${metadata.topicName}`);
  },
);

/**
 * Handles `POST /api/queue/callback` for asynchronous thread processing.
 *
 * Keep this route as a dedicated handler in app code. The catch-all router can
 * mirror this path for local/dev parity, but production queue delivery should
 * always target the dedicated endpoint.
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
          "error.message": message,
        },
        "Queue callback processing failed",
      );
      logException(error, "queue_callback_failed");
      throw error;
    }
  });
}
