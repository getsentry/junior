// The inputs of a Turn. Each input row carries its Turn from the time it is
// written, and its idempotency key is unique in the Conversation.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Turn } from "@/core/turn/state";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorTurnInbox, juniorTurns } from "@/db/schema";

type InboxRow = typeof juniorTurnInbox.$inferInsert;

/** One input from a source, such as a message, before it has a Turn. */
export type Input = {
  conversationId: string;
  kind: InboxRow["kind"];
  actorIdentityId: string;
  payload: InboxRow["payload"];
  /** The source's id for the input, such as a Slack event id. */
  idempotencyKey: string;
  sentAt: Date;
  traceContext?: NonNullable<InboxRow["traceContext"]>;
};

/** Adds an input to a Turn of the same Conversation. */
export async function addInput(
  executor: JuniorSqlDatabase,
  input: Input & { turnId: string },
): Promise<void> {
  await executor
    .db()
    .insert(juniorTurnInbox)
    .values({ ...input, id: randomUUID() });
}

/**
 * Finds the Turn of the input that has this idempotency key in the
 * Conversation. Undefined when no such input exists.
 */
export async function findInputTurn(
  executor: JuniorSqlDatabase,
  args: { conversationId: string; idempotencyKey: string },
): Promise<Turn | undefined> {
  const [turn] = await executor
    .db()
    .select({ turnId: juniorTurns.id, state: juniorTurns.state })
    .from(juniorTurnInbox)
    .innerJoin(juniorTurns, eq(juniorTurns.id, juniorTurnInbox.turnId))
    .where(
      and(
        eq(juniorTurnInbox.conversationId, args.conversationId),
        eq(juniorTurnInbox.idempotencyKey, args.idempotencyKey),
      ),
    );
  return turn;
}
