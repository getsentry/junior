// The inputs of a Turn. Each input row carries its Turn from the time it is
// written, and its idempotency key is unique in the Conversation. An input is
// read once the Conversation history has its event, keyed `inbox:<row id>`.
import type { UserMessage } from "@earendil-works/pi-ai";
import { and, asc, eq, inArray, notExists, sql } from "drizzle-orm";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import type { EngineContext } from "@/core/engine-context";
import type { Turn } from "@/core/turn/state";
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
 * Finds the Turn of the input that has this idempotency key in the
 * Conversation. Undefined when no such input exists.
 */
export async function findInputTurn(
  { executor }: Pick<EngineContext, "executor">,
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
  /** When an attempt of the Turn first claimed it with the input unread. */
  attemptedAt: Date | null;
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
  { executor }: Pick<EngineContext, "executor">,
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
      attemptedAt: juniorTurnInbox.attemptedAt,
    })
    .from(juniorTurnInbox)
    .where(and(eq(juniorTurnInbox.turnId, turnId), notExists(readEvent)))
    .orderBy(asc(juniorTurnInbox.sentAt), asc(juniorTurnInbox.createdAt));
}

/**
 * Records that an attempt of the Turn claimed it with these inputs unread.
 * The first attempt keeps its time. It does not mark the inputs read.
 */
export async function markInputsAttempted(
  { executor }: Pick<EngineContext, "executor">,
  inputIds: string[],
): Promise<void> {
  if (inputIds.length === 0) {
    return;
  }
  await executor
    .db()
    .update(juniorTurnInbox)
    .set({ attemptedAt: sql`coalesce(${juniorTurnInbox.attemptedAt}, now())` })
    .where(inArray(juniorTurnInbox.id, inputIds));
}
