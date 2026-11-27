// The queue message that says a Turn ended. Core sends it after the commit
// that ends the Turn, and again on each `reconcileTurn` of an ended Turn, so a
// handler gets it at least once and must be safe to run twice. Core does not
// know who handles it: the host does what follows the Turn, such as sending
// its replies from the outbox. A handler reads only what the end committed.
import * as z from "zod";
import { logWarn } from "@/chat/logging";
import type {
  QueueConsumer,
  QueueMessageMetadata,
} from "@/chat/queue/provider";
import type { EngineContext } from "@/core/engine-context";
import { signedTopic } from "@/core/queue";
import { TURN_ENDED_TOPIC } from "@/core/turn/topic";

const turnEndedMessageSchema = z
  .object({
    conversationId: z.string().min(1),
    turnId: z.string().min(1),
    traceContext: z
      .object({ sentryTrace: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

/** The Turn that ended, and its Conversation. */
export type TurnEndedMessage = { conversationId: string; turnId: string };

const turnEndedTopic = signedTopic<TurnEndedMessage>({
  topic: TURN_ENDED_TOPIC,
  sign: {
    context: "junior.turn_ended.v1",
    schema: turnEndedMessageSchema,
    signatureVersion: "v1",
    parts: (message) => [
      message.conversationId,
      message.turnId,
      message.traceContext?.sentryTrace ?? "",
    ],
  },
  onRejected: (attributes) =>
    logWarn("turn.ended.queue_message.rejected", attributes),
  attributes: (message) => ({
    "app.turn.id": message.turnId,
    "gen_ai.conversation.id": message.conversationId,
  }),
});

/**
 * Sends the message that the Turn ended, after `delayMs` if set. A handler
 * that must try its work again later sends it again with a delay.
 */
export async function publishTurnEnded(
  ctx: Pick<EngineContext, "queue">,
  message: TurnEndedMessage,
  options: { delayMs?: number } = {},
): Promise<void> {
  await turnEndedTopic.publish(ctx, message, options);
}

/** Handles one message that a Turn ended, inside the `queue.process` span. */
export type HandleTurnEnded = (
  message: TurnEndedMessage,
  metadata: QueueMessageMetadata,
) => Promise<void>;

/**
 * Reads the messages that a Turn ended: it checks that core sent each one,
 * then calls `handle`. It acknowledges a message with a bad or expired
 * signature and retries one that cannot be checked yet. The host mounts the
 * consumer on its queue provider.
 */
export function readTurnEndedMessages(
  ctx: Pick<EngineContext, "queue" | "leaseMs">,
  handle: HandleTurnEnded,
): QueueConsumer {
  return turnEndedTopic.consumer(ctx, (message, metadata) =>
    handle(
      { conversationId: message.conversationId, turnId: message.turnId },
      metadata,
    ),
  );
}
