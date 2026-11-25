// The queue message that runs the next step of a Turn. The message holds only
// the Turn id: the database owns the Turn's state and its attempts, so a
// message sent twice or late runs no step twice. Each step runs in its own
// trace, which links to the span that published the message.
import * as z from "zod";
import { logWarn } from "@/chat/logging";
import type {
  QueueConsumer,
  QueueMessageMetadata,
} from "@/chat/queue/provider";
import type { EngineContext } from "@/core/engine-context";
import { signedTopic } from "@/core/queue";
import { TURN_STEP_TOPIC } from "@/core/turn/topic";

const turnStepMessageSchema = z
  .object({
    turnId: z.string().min(1),
    traceContext: z
      .object({ sentryTrace: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

type TurnStepMessage = { turnId: string };

const turnStepTopic = signedTopic<TurnStepMessage>({
  topic: TURN_STEP_TOPIC,
  sign: {
    context: "junior.turn_step.v1",
    schema: turnStepMessageSchema,
    signatureVersion: "v1",
    parts: (message) => [
      message.turnId,
      message.traceContext?.sentryTrace ?? "",
    ],
  },
  onRejected: (attributes) =>
    logWarn("turn.step.queue_message.rejected", attributes),
  attributes: (message) => ({ "app.turn.id": message.turnId }),
});

/**
 * Sends a message that runs the next step of a Turn. `idempotencyKey` drops a
 * second send with the same key.
 */
export async function publishTurnStep(
  ctx: Pick<EngineContext, "queue">,
  turnId: string,
  options: { delayMs?: number; idempotencyKey?: string } = {},
): Promise<void> {
  await turnStepTopic.publish(ctx, { turnId }, options);
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
 * advanceTurn fails a Turn after `maxAttempts` tries of one step. The host
 * mounts the consumer on its queue provider.
 */
export function createTurnStepConsumer(
  ctx: Pick<EngineContext, "queue" | "leaseMs">,
  run: RunTurnStep,
): QueueConsumer {
  return turnStepTopic.consumer(ctx, (message, metadata) =>
    run({ turnId: message.turnId }, metadata),
  );
}
