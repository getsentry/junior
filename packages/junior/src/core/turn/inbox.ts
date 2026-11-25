// The inbox holds the inputs that no Turn has taken yet. Each input row
// carries its Turn from the time it is written, and its idempotency key is
// unique in the Conversation. A row leaves the inbox in the transaction that
// writes it to the Conversation history: the step commit that reads it, or
// the end of its Turn, which drops it. So an input is in exactly one place.
import type { Destination, Source } from "@sentry/junior-plugin-api";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import type { EngineContext } from "@/core/engine-context";
import type { Turn } from "@/core/turn/state";
import {
  juniorConversationEvents,
  juniorTurnInbox,
  juniorTurns,
} from "@/db/schema";
import type {
  TurnInputMessage,
  TurnInputTraceContext,
} from "@/db/schema/turn-inbox";

/**
 * Something that arrived in a Conversation for Junior to act on. It waits in
 * the inbox until a Turn reads it, and each input belongs to exactly one Turn.
 * This type is the row before the scheduler sets its `turnId`.
 */
export type TurnInput = {
  conversationId: string;
  actorIdentityId: string;
  /**
   * Where the input came from. Core compares only its `kind`, and a Turn
   * created for the input keeps it.
   */
  source: Source;
  /**
   * Where the answer to the input goes, or null when the Conversation history
   * is the only answer. The code that sends the input decides it, and a Turn
   * created for the input keeps it.
   */
  destination: Destination | null;
  payload: Record<string, unknown>;
  /** The input as the transcript shows it, once a Turn takes it. */
  message: TurnInputMessage;
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
 * Conversation. Undefined when no such input waits in the inbox.
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

// The key of an input's transcript Message event. Every input that leaves the
// inbox writes one, read or dropped, so it marks the input as handled.
function inputMessageEventKey(idempotencyKey: string): string {
  return `input:${idempotencyKey}`;
}

/**
 * True when an input with this idempotency key already left the inbox, so the
 * Conversation history has it.
 */
export async function isInputInHistory(
  { executor }: Pick<EngineContext, "executor">,
  args: { conversationId: string; idempotencyKey: string },
): Promise<boolean> {
  const rows = await executor
    .db()
    .select({ seq: juniorConversationEvents.seq })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, args.conversationId),
        eq(
          juniorConversationEvents.idempotencyKey,
          inputMessageEventKey(args.idempotencyKey),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** An input of a Turn that waits in the inbox. */
export type UnreadInput = Pick<TurnInput, "payload" | "sentAt"> & {
  inputId: string;
  traceContext: TurnInputTraceContext | null;
  /** When an attempt of the Turn first claimed it with the input unread. */
  attemptedAt: Date | null;
};

/** The idempotency key of the model history event that reads an input. */
export function inputEventKey(inputId: string): string {
  return `inbox:${inputId}`;
}

/** Finds the inputs of a Turn that wait in the inbox, oldest first. */
export async function findUnreadInputs(
  { executor }: Pick<EngineContext, "executor">,
  turnId: string,
): Promise<UnreadInput[]> {
  return executor
    .db()
    .select({
      inputId: juniorTurnInbox.id,
      payload: juniorTurnInbox.payload,
      sentAt: juniorTurnInbox.sentAt,
      traceContext: juniorTurnInbox.traceContext,
      attemptedAt: juniorTurnInbox.attemptedAt,
    })
    .from(juniorTurnInbox)
    .where(eq(juniorTurnInbox.turnId, turnId))
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

/** Why an input left the inbox with no step that read it. */
export type DroppedInputReason = "stopped" | "superseded" | "failed";

/**
 * Takes inputs out of the inbox: deletes their rows and appends each input's
 * transcript Message to the Conversation history. A dropped input's Message
 * has `skippedReason`, like a Slack message that Junior skips, and no model
 * history item, so no Turn answers it. Call it in the transaction that ends
 * the input's Turn or commits the step that read it, under the Conversation
 * lock. Only retention deletes inbox rows any other way.
 */
export async function takeInputs(
  { executor }: Pick<EngineContext, "executor">,
  conversationId: string,
  take:
    | { inputIds: string[] }
    | { turnIds: string[]; skippedReason: DroppedInputReason },
): Promise<void> {
  const ids = "inputIds" in take ? take.inputIds : take.turnIds;
  if (ids.length === 0) {
    return;
  }
  const deleted = await executor
    .db()
    .delete(juniorTurnInbox)
    .where(
      inArray(
        "inputIds" in take ? juniorTurnInbox.id : juniorTurnInbox.turnId,
        ids,
      ),
    )
    .returning({
      idempotencyKey: juniorTurnInbox.idempotencyKey,
      message: juniorTurnInbox.message,
      sentAt: juniorTurnInbox.sentAt,
      createdAt: juniorTurnInbox.createdAt,
    });
  const skippedReason =
    "skippedReason" in take ? take.skippedReason : undefined;
  await createSqlConversationEventStore(executor).append(
    conversationId,
    deleted
      .sort(
        (a, b) =>
          a.sentAt.getTime() - b.sentAt.getTime() ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      )
      .map((row) => ({
        data: {
          type: "message" as const,
          role: "user" as const,
          ...row.message,
          meta: skippedReason
            ? { ...row.message.meta, replied: false, skippedReason }
            : row.message.meta,
        },
        idempotencyKey: inputMessageEventKey(row.idempotencyKey),
        createdAtMs: row.sentAt.getTime(),
      })),
  );
}
