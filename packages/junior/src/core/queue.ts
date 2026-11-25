// A signed core queue topic. Each message is signed, so the public callback
// runs only messages that this deployment sent. Publish and consume record the
// same spans and attributes for every topic. Core's Turn and outbox rows own
// each attempt limit, so the queue retries a failed message without a limit.
import type {
  QueueConsumer,
  QueueMessageMetadata,
} from "@/chat/queue/provider";
import {
  QUEUE_SIGNATURE_MAX_AGE_MS,
  type QueueSignConfig,
  signQueueMessage,
  verifyQueueMessage,
} from "@/chat/queue/sign";
import type { EngineContext } from "@/core/engine-context";
import {
  activeTraceContext,
  type SpanAttributes,
  type TraceContext,
  withSpan,
} from "@/core/telemetry";

// The queue sends a message again only after the host stops a run that takes
// too long, so a live run is not delivered twice.
const VISIBILITY_TIMEOUT_BUFFER_SECONDS = 30;

type Signed = { traceContext?: TraceContext };

/** Defines one signed topic. Returns its publish function and its consumer. */
export function signedTopic<Message extends object>(def: {
  topic: string;
  sign: QueueSignConfig<Message & Signed, "v1">;
  /** Logs a message with a bad or expired signature. The queue drops it. */
  onRejected: (attributes: Record<string, string | number>) => void;
  /** Ids of the message, set on both the publish and the process span. */
  attributes: (message: Message) => SpanAttributes;
}) {
  const publish = async (
    { queue }: Pick<EngineContext, "queue">,
    message: Message,
    options: { delayMs?: number; idempotencyKey?: string } = {},
  ): Promise<void> => {
    await withSpan(
      "queue.publish",
      {
        ...def.attributes(message),
        "messaging.destination.name": def.topic,
        "messaging.system": queue.messagingSystem,
      },
      async (span) => {
        const traceContext = activeTraceContext();
        const payload = signQueueMessage(
          def.sign,
          traceContext ? { ...message, traceContext } : message,
        );
        // The queue sends the payload as these UTF-8 JSON bytes.
        span.setAttribute(
          "messaging.message.body.size",
          Buffer.byteLength(JSON.stringify(payload)),
        );
        const result = await queue.send(def.topic, payload, {
          delaySeconds:
            options.delayMs && options.delayMs > 0
              ? Math.ceil(options.delayMs / 1000)
              : undefined,
          idempotencyKey: options.idempotencyKey,
          // A message older than its signature is rejected, so the queue drops it.
          retentionSeconds: QUEUE_SIGNATURE_MAX_AGE_MS / 1000,
        });
        if (result.messageId) {
          span.setAttribute("messaging.message.id", result.messageId);
        }
      },
    );
  };

  const consumer = (
    { queue, leaseMs }: Pick<EngineContext, "queue" | "leaseMs">,
    // Gets the verified message with its trace context.
    run: (
      message: Message & Signed,
      metadata: QueueMessageMetadata,
    ) => Promise<void>,
  ): QueueConsumer => ({
    handler: async (value, metadata) => {
      const checked = verifyQueueMessage(def.sign, value);
      if (checked.status === "rejected") {
        def.onRejected({
          "app.queue.consumer_group": metadata.consumerGroup,
          "app.queue.delivery_count": metadata.deliveryCount,
          "app.queue.message_id": metadata.messageId,
          "app.queue.reject_reason": checked.reason,
          "app.queue.topic_name": metadata.topicName,
        });
        return;
      }
      if (checked.status === "unavailable") {
        throw new Error(
          `Queue message verification unavailable: ${checked.reason}`,
        );
      }
      const message = checked.message;
      await withSpan(
        "queue.process",
        {
          ...def.attributes(message),
          "messaging.destination.name": metadata.topicName,
          "messaging.system": queue.messagingSystem,
          "messaging.message.id": metadata.messageId,
          "messaging.message.receive.latency":
            Date.now() - metadata.createdAt.getTime(),
          "messaging.message.retry.count": metadata.deliveryCount - 1,
        },
        () => run(message, metadata),
        {
          links: message.traceContext ? [message.traceContext] : [],
          newTrace: true,
        },
      );
    },
    retry: () => undefined,
    visibilityTimeoutSeconds:
      leaseMs / 1000 + VISIBILITY_TIMEOUT_BUFFER_SECONDS,
  });

  return { publish, consumer };
}
