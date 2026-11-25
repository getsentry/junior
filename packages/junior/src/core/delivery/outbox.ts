// The outbox rows of a Turn: one row per reply that Delivery must send. The
// commit that writes a step's replies writes their rows too, so a reply is
// never in history without a row that a delivery message or the sweep finds.
import { randomUUID } from "node:crypto";
import type { EngineContext } from "@/core/engine-context";
import { findTurnDestination } from "@/core/turn/inbox";
import { findTurnReplies } from "@/core/turn/replies";
import { juniorTurnOutbox } from "@/db/schema";

/**
 * Adds an outbox row for each reply of the Turn that has none, but only while
 * the Turn has a Destination. Call it in the transaction that commits the
 * replies.
 */
export async function recordReplies(
  { executor }: Pick<EngineContext, "executor">,
  turn: { conversationId: string; turnId: string },
): Promise<void> {
  const destination = await findTurnDestination({ executor }, turn.turnId);
  if (!destination) {
    return;
  }
  const replies = await findTurnReplies(
    { executor },
    turn.conversationId,
    turn.turnId,
  );
  if (replies.length === 0) {
    return;
  }
  await executor
    .db()
    .insert(juniorTurnOutbox)
    .values(
      replies.map((row) => ({
        id: randomUUID(),
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        eventSeq: row.seq,
        destination,
        state: "pending" as const,
      })),
    )
    .onConflictDoNothing({
      target: [juniorTurnOutbox.conversationId, juniorTurnOutbox.eventSeq],
    });
}
