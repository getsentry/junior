// Compat: exists only so main's readers keep working; delete it once they
// read `junior_turns`. Core writes only agent history, but the dashboard,
// status, ACP and the eval fixture read the visible messages and Turn
// lifecycle events. This writes them when a core Turn reads inputs, with main's
// shapes and idempotency keys.
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { turnStartedKey } from "@/chat/conversations/turn-lifecycle";
import type { EngineContext } from "@/core/engine-context";
import { findTurnDestination, type UnreadInput } from "@/core/turn/inbox";
import type { ClaimedTurn } from "@/core/turn/state";
import { turnInputPayloadSchema } from "./input-payload";
import { compat__personMessageId } from "./compat__message-id";

/**
 * Compat: writes the person's visible `message` event for each input that a
 * step reads, and at the Turn's first step its `turn_started` event with
 * those inputs. Idempotency keys make a second run write nothing.
 */
export async function compat__writeInputsRead(
  { executor }: Pick<EngineContext, "executor">,
  turn: ClaimedTurn,
  inputs: UnreadInput[],
): Promise<void> {
  const messages = inputs.map((input) => {
    const messageId = compat__personMessageId(input.inputId);
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
  // Each commit moves step_seq, so a claim at 0 has no committed step.
  const started =
    turn.stepSeq === 0
      ? [
          {
            idempotencyKey: turnStartedKey(turn.turnId),
            createdAtMs: Date.now(),
            data: {
              type: "turn_started" as const,
              turnId: turn.turnId,
              inputMessageIds: messages.map(
                (message) => message.data.messageId,
              ),
              surface: await turnSurface({ executor }, turn.turnId),
            },
          },
        ]
      : [];
  await executor.transaction(() =>
    createSqlConversationEventStore(executor).append(turn.conversationId, [
      ...messages,
      ...started,
    ]),
  );
}

// Main's surfaces name the product, not the platform. A core Turn that
// answers in Slack is a Slack Turn; any other is an API Turn.
async function turnSurface(
  { executor }: Pick<EngineContext, "executor">,
  turnId: string,
): Promise<"slack" | "api"> {
  const destination = await findTurnDestination({ executor }, turnId);
  return destination?.["platform"] === "slack" ? "slack" : "api";
}
