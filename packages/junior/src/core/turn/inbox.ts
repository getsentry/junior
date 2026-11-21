// The inputs of a Turn. Each input row carries its Turn from the time it is
// written, and its idempotency key is unique in the Conversation. An input is
// read once the Conversation history has its event, keyed `inbox:<row id>`.
import { randomUUID } from "node:crypto";
import type { UserMessage } from "@earendil-works/pi-ai";
import { and, asc, eq, notExists, sql } from "drizzle-orm";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import type { Turn } from "@/core/turn/state";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorConversationEvents,
  juniorTurnInbox,
  juniorTurns,
} from "@/db/schema";
import type { TurnInputTraceContext } from "@/db/schema/turn-inbox";

/**
 * Something that arrived in a Conversation for Junior to act on. It waits in
 * the inbox until a Turn reads it, and each input belongs to exactly one Turn.
 * This type is the row before the scheduler sets its `turnId`.
 */
export type TurnInput = {
  conversationId: string;
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

const INPUT_EVENT_KEY_PREFIX = "inbox:";

/** An input of a Turn that no history event has read yet. */
export type UnreadInput = Pick<
  TurnInput,
  "actorIdentityId" | "payload" | "sentAt"
> & {
  inputId: string;
  traceContext: TurnInputTraceContext | null;
};

/** An unread input as the user message that a step reads, and its provenance. */
export type InputMessage = {
  inputId: string;
  message: UserMessage;
  provenance: ConversationMessageProvenance;
};

/** The idempotency key of the history event that reads an input. */
export function inputEventKey(inputId: string): string {
  return `${INPUT_EVENT_KEY_PREFIX}${inputId}`;
}

/** Finds the inputs of a Turn that the history has not read, oldest first. */
export async function findUnreadInputs(
  executor: JuniorSqlDatabase,
  turnId: string,
): Promise<UnreadInput[]> {
  const db = executor.db();
  const readEvent = db
    .select({ one: sql`1` })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(
          juniorConversationEvents.conversationId,
          juniorTurnInbox.conversationId,
        ),
        eq(
          juniorConversationEvents.idempotencyKey,
          sql`${INPUT_EVENT_KEY_PREFIX}::text || ${juniorTurnInbox.id}::text`,
        ),
      ),
    );
  return db
    .select({
      inputId: juniorTurnInbox.id,
      actorIdentityId: juniorTurnInbox.actorIdentityId,
      payload: juniorTurnInbox.payload,
      sentAt: juniorTurnInbox.sentAt,
      traceContext: juniorTurnInbox.traceContext,
    })
    .from(juniorTurnInbox)
    .where(and(eq(juniorTurnInbox.turnId, turnId), notExists(readEvent)))
    .orderBy(asc(juniorTurnInbox.sentAt), asc(juniorTurnInbox.createdAt));
}
