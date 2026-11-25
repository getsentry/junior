// The inputs of a Turn. Each input row carries its Turn from the time it is
// written, and its idempotency key is unique in the Conversation. An input is
// read once the Conversation history has its event, keyed `inbox:<row id>`.
import {
  destinationSchema,
  type Destination,
  type Source,
} from "@sentry/junior-plugin-api";
import { and, asc, eq, inArray, notExists, sql } from "drizzle-orm";
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
  /** Who sent the input. Core stores it and does not read it. */
  actorIdentityId: string;
  /** Where the input came from. Core stores it and does not read it. */
  source: Source;
  /**
   * Which inputs may share a Turn. The host builds it and core only compares
   * it: an input joins a Turn only when the Turn's inputs have the same key.
   */
  groupKey: string;
  /**
   * Where the answer to the input goes, or null when the Conversation history
   * is the only answer. The code that sends the input decides it.
   */
  destination: Destination | null;
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

/**
 * Finds where a Turn's answer goes: the Destination of its first input. Null
 * when the Turn answers only in the Conversation history.
 */
export async function findTurnDestination(
  { executor }: Pick<EngineContext, "executor">,
  turnId: string,
): Promise<Destination | null> {
  const [input] = await executor
    .db()
    .select({ destination: juniorTurnInbox.destination })
    .from(juniorTurnInbox)
    .where(eq(juniorTurnInbox.turnId, turnId))
    .orderBy(asc(juniorTurnInbox.createdAt), asc(juniorTurnInbox.id))
    .limit(1);
  return input?.destination ? destinationSchema.parse(input.destination) : null;
}

/** An input of a Turn, whether the history has read it or not. */
export type TurnInputRecord = Pick<TurnInput, "payload"> & {
  inputId: string;
};

/** Finds every input of a Turn, oldest first. */
export async function findTurnInputs(
  { executor }: Pick<EngineContext, "executor">,
  turnId: string,
): Promise<TurnInputRecord[]> {
  return executor
    .db()
    .select({
      inputId: juniorTurnInbox.id,
      payload: juniorTurnInbox.payload,
    })
    .from(juniorTurnInbox)
    .where(eq(juniorTurnInbox.turnId, turnId))
    .orderBy(asc(juniorTurnInbox.sentAt), asc(juniorTurnInbox.createdAt));
}

const INPUT_EVENT_KEY_PREFIX = "inbox:";

/** An input of a Turn that no history event has read yet. */
export type UnreadInput = Pick<TurnInput, "groupKey" | "payload" | "sentAt"> & {
  inputId: string;
  traceContext: TurnInputTraceContext | null;
  /** When an attempt of the Turn first claimed it with the input unread. */
  attemptedAt: Date | null;
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
      groupKey: juniorTurnInbox.groupKey,
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
