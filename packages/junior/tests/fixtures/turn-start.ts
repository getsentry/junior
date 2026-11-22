import { getTurnLifecycle } from "@/chat/conversations/turn-lifecycle";

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
