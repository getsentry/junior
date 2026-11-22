// The queue message that runs the next step of a Turn. The message holds only
// the Turn id: the database owns the Turn's state and its attempts, so a
// message sent twice or late runs no step twice. Each step runs in its own
// trace, which links to the span that published the message.
import * as z from "zod";
import { getChatConfig } from "@/chat/config";
import { logWarn } from "@/chat/logging";
import { queueCallback } from "@/chat/queue/callback";
import {
  getQueueProvider,
  type QueueMessageMetadata,
} from "@/chat/queue/provider";
import {
  QUEUE_SIGNATURE_MAX_AGE_MS,
  signQueueMessage,
  verifyQueueMessage,
} from "@/chat/queue/sign";
import { activeTraceContext, withSpan } from "@/core/telemetry";

/** Queue topic of Turn step messages. */
export const TURN_STEP_TOPIC = "junior_turn_step";

const TURN_STEP_CONSUMER_GROUP = "junior_turn_step";

// The queue sends a message again only after the host stops a step that runs
// too long, so a live step is not delivered twice.
const VISIBILITY_TIMEOUT_BUFFER_SECONDS = 30;

const turnStepMessageSchema = z
  .object({
    turnId: z.string().min(1),
    traceContext: z
      .object({ sentryTrace: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

type TurnStepMessage = z.output<typeof turnStepMessageSchema>;

const turnStepSign = {
  context: "junior.turn_step.v1",
  schema: turnStepMessageSchema,
  signatureVersion: "v1" as const,
  parts: (message: TurnStepMessage) => [
    message.turnId,
    message.traceContext?.sentryTrace ?? "",
  ],
};

/**
 * Sends a message that runs the next step of a Turn. `idempotencyKey` drops a
 * second send with the same key.
 */
export async function publishTurnStep(
  turnId: string,
  options: { delayMs?: number; idempotencyKey?: string } = {},
): Promise<void> {
  const queue = getQueueProvider();
  await withSpan(
    "queue.publish",
    {
      "app.turn.id": turnId,
      "messaging.destination.name": TURN_STEP_TOPIC,
      "messaging.system": queue.messagingSystem,
    },
    async (span) => {
      const traceContext = activeTraceContext();
      const payload = signQueueMessage(
        turnStepSign,
        traceContext ? { turnId, traceContext } : { turnId },
      );
      // The queue sends the payload as these UTF-8 JSON bytes.
      span.setAttribute(
        "messaging.message.body.size",
        Buffer.byteLength(JSON.stringify(payload)),
      );
      const result = await queue.send(TURN_STEP_TOPIC, payload, {
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
}

/**
 * Runs one Turn step message inside the `queue.process` span. Set ids that
 * the claim returns on that span with `setActiveSpanAttributes`.
 */
export type RunTurnStep = (
  message: { turnId: string },
  metadata: QueueMessageMetadata,
) => Promise<void>;

/**
 * Builds the queue consumer of Turn step messages. It acknowledges a message
 * with a bad or expired signature and retries one that cannot be checked yet.
 */
export function createTurnStepConsumer(run: RunTurnStep) {
  return queueCallback<TurnStepMessage>({
    consumerGroup: TURN_STEP_CONSUMER_GROUP,
    // advanceTurn fails a Turn after `maxAttempts` tries of one step, so the
    // queue retries without a limit.
    maxDeliveries: null,
    onRejected: (reason, metadata) => {
      logWarn("turn.step.queue_message.rejected", {
        "app.queue.consumer_group": metadata.consumerGroup,
        "app.queue.delivery_count": metadata.deliveryCount,
        "app.queue.message_id": metadata.messageId,
        "app.queue.reject_reason": reason,
        "app.queue.topic_name": metadata.topicName,
      });
    },
    run: (message, metadata) =>
      withSpan(
        "queue.process",
        {
          "app.turn.id": message.turnId,
          "messaging.destination.name": metadata.topicName,
          "messaging.system": getQueueProvider().messagingSystem,
          "messaging.message.id": metadata.messageId,
          "messaging.message.receive.latency":
            Date.now() - metadata.createdAt.getTime(),
          "messaging.message.retry.count": metadata.deliveryCount - 1,
        },
        () => run({ turnId: message.turnId }, metadata),
        {
          links: message.traceContext ? [message.traceContext] : [],
          newTrace: true,
        },
      ),
    topic: TURN_STEP_TOPIC,
    verify: (value) => verifyQueueMessage(turnStepSign, value),
    visibilityTimeoutSeconds:
      getChatConfig().functionMaxDurationSeconds +
      VISIBILITY_TIMEOUT_BUFFER_SECONDS,
  });
}
