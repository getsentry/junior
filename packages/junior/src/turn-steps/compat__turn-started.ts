// Compat: exists only so main's readers keep working; delete it once they
// read `junior_turns`. Core writes only agent history, but the dashboard,
// status, ACP and the eval fixture read the visible messages and Turn
// lifecycle events. This writes them when a core Turn starts, with main's
// shapes and idempotency keys.
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { turnStartedKey } from "@/chat/conversations/turn-lifecycle";
import type { EngineContext } from "@/core/engine-context";
import { findTurnDestination, type TurnInputRecord } from "@/core/turn/inbox";
import type { ClaimedTurn } from "@/core/turn/state";
import { turnInputPayloadSchema } from "./input-payload";
import { compat__inputMessageId } from "./compat__message-id";

/**
 * Compat: writes the person's visible `message` events for the Turn's
 * inputs, then its `turn_started` event. Idempotency keys make a second run
 * write nothing.
 */
export async function compat__writeTurnStarted(
  { executor }: Pick<EngineContext, "executor">,
  turn: ClaimedTurn,
  inputs: TurnInputRecord[],
): Promise<void> {
  const destination = await findTurnDestination({ executor }, turn.turnId);
  const messages = inputs.map((input) => {
    const messageId = compat__inputMessageId(input.inputId);
    return {
      idempotencyKey: `message:${messageId}`,
      createdAtMs: input.sentAt.getTime(),
      data: {
        type: "message" as const,
        messageId,
        role: "user" as const,
        text: turnInputPayloadSchema.parse(input.payload).text,
        authorIdentityId: input.actorIdentityId,
      },
    };
  });
  await executor.transaction(() =>
    createSqlConversationEventStore(executor).append(turn.conversationId, [
      ...messages,
      {
        idempotencyKey: turnStartedKey(turn.turnId),
        createdAtMs: Date.now(),
        data: {
          type: "turn_started",
          turnId: turn.turnId,
          inputMessageIds: messages.map((message) => message.data.messageId),
          // Main's surfaces name the product, not the platform. A core Turn
          // that answers in Slack is a Slack Turn; any other is an API Turn.
          surface: destination?.["platform"] === "slack" ? "slack" : "api",
        },
      },
    ]),
  );
}
