import { getTurnLifecycle } from "@/chat/conversations/turn-lifecycle";
import { getConversationEventStore } from "@/chat/db";

/**
 * Record the `turn_started` event of a Turn, as its owner does before the
 * Turn commits messages. Messages committed after it belong to the Turn.
 */
export async function recordTurnStart(
  conversationId: string,
  turnId: string,
): Promise<void> {
  await getTurnLifecycle().start({
    conversationId,
    createdAtMs: 0,
    inputMessageIds: [`${turnId}:input`],
    surface: "internal",
    turnId,
  });
}

/**
 * Store the terminal event of a Turn, as the Turn lifecycle does. It does not
 * publish the Turn end, so a child's end does not wake its parent.
 */
async function recordTurnEnd(
  conversationId: string,
  turnId: string,
  data:
    | { type: "turn_completed"; outcome: "no_reply" }
    | { type: "turn_failed"; failureCode: "model_execution_failed" },
): Promise<void> {
  await getConversationEventStore().append(conversationId, [
    {
      createdAtMs: 0,
      data: { ...data, turnId },
      idempotencyKey: `turn:${turnId}:terminal`,
    },
  ]);
}

/** Record the `turn_completed` event of a Turn that posted no reply. */
export async function recordTurnCompletion(
  conversationId: string,
  turnId: string,
): Promise<void> {
  await recordTurnEnd(conversationId, turnId, {
    type: "turn_completed",
    outcome: "no_reply",
  });
}

/** Record the `turn_failed` event of a Turn, as its owner does on a failure. */
export async function recordTurnFailure(
  conversationId: string,
  turnId: string,
): Promise<void> {
  await recordTurnEnd(conversationId, turnId, {
    type: "turn_failed",
    failureCode: "model_execution_failed",
  });
}
