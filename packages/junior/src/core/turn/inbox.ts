// The inputs of a Turn. Each input row carries its Turn from the time it is
// written, and its idempotency key is unique in the Conversation.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Turn } from "@/core/turn/state";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorTurnInbox, juniorTurns } from "@/db/schema";
import type {
  TurnInputKind,
  TurnInputTraceContext,
} from "@/db/schema/turn-inbox";

/**
 * Something that arrived in a Conversation for Junior to act on: a person's
 * message, or an account that a person connected (`kind`). It waits in the
 * inbox until a Turn reads it, and each input belongs to exactly one Turn.
 * This type is the row before the scheduler sets its `turnId`.
 */
export type TurnInput = {
  conversationId: string;
  kind: TurnInputKind;
  actorIdentityId: string;
  payload: Record<string, unknown>;
  /**
   * The same key on every delivery of this input, so a redelivery writes
   * nothing. The Source gives it, for example the Slack message id or the
   * `idempotencyKey` that a web or MCP client sends with a message.
   */
  idempotencyKey: string;
  sentAt: Date;
  traceContext?: TurnInputTraceContext;
};

/**
 * Adds an input to a Turn of the same Conversation. It resolves once the row
 * is written and throws on any failure, such as a duplicate idempotency key.
 */
export async function addInput(
  executor: JuniorSqlDatabase,
  input: TurnInput & { turnId: string },
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
