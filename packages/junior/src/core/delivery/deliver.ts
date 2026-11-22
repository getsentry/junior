// Delivery of a Turn's replies to the Conversation's Location. Each step
// commit publishes a delivery message. Its consumer records every reply of
// the Turn as an outbox row, then sends the Conversation's pending rows in
// event order under a lock on the Conversation. Each send commits its own
// row, so a crash sends at most that one reply again.
import { randomUUID } from "node:crypto";
import { and, asc, eq, like, sql } from "drizzle-orm";
import * as z from "zod";
import {
  canPauseConversationDelivery,
  isConversationDeliveryPaused,
} from "@/chat/conversations/delivery-pause";
import { locationSchema, type Location } from "@/chat/conversations/location";
import { conversationKindFromRow } from "@/chat/conversations/sql/conversation-row";
import { eventFromRow } from "@/chat/conversations/sql/history";
import { logException } from "@/chat/logging";
import { piMessageFromHistoryItem } from "@/chat/pi/conversation-events";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import { publishDelivery, type DeliveryMessage } from "@/core/delivery/queue";
import { findTurn, turnEventKeyPrefix } from "@/core/turn/state";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorConversationEvents,
  juniorConversations,
  juniorTurnOutbox,
} from "@/db/schema";

/**
 * Sends one reply to a Location. It throws `DeliveryRetryableError` when a
 * later try can work, and any other error when it cannot.
 */
export type DeliverySender = (input: {
  conversationId: string;
  location: Location;
  text: string;
}) => Promise<{ providerMessageId?: string }>;

/** The sender of each Location provider that this app delivers to. */
export type DeliverySenders = Partial<
  Record<Location["provider"], DeliverySender>
>;

/**
 * A send that failed but can work on a later try. The sender sets
 * `retryAfterMs` when the provider says when to try again.
 */
export class DeliveryRetryableError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: { cause?: unknown; retryAfterMs?: number | undefined } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "DeliveryRetryableError";
    this.retryAfterMs = options.retryAfterMs;
  }
}

// Another delivery of the Conversation holds the lock. It sends the rows that
// are pending when it looks again, so this one only checks back soon.
const LOCK_MISS_DELAY_MS = 1_000;
// A row fails after this many retryable failures, so the rows after it are
// not stuck behind it.
const MAX_DELIVERY_ATTEMPTS = 5;
// A retryable send waits longer after each attempt, unless the sender's error
// says when to retry.
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 60_000;

const tryLockResultSchema = z.object({
  rows: z.tuple([z.object({ locked: z.boolean() })]),
});

/**
 * Publishes the delivery message of a Turn after one of its steps commits.
 * It is safe to repeat: the outbox sends each reply once.
 */
export async function stepCommitted(
  executor: JuniorSqlDatabase,
  turnId: string,
): Promise<void> {
  const turn = await findTurn(executor, turnId);
  if (!turn) {
    return;
  }
  await publishDelivery({ conversationId: turn.conversationId, turnId });
}

/**
 * Delivers the replies of a Turn: it records them in the outbox, then sends
 * the Conversation's pending rows in order. A root Conversation with a
 * Location delivers, unless its Delivery is paused.
 */
export async function deliverTurn(
  executor: JuniorSqlDatabase,
  message: DeliveryMessage,
  senders: DeliverySenders,
): Promise<void> {
  if (!(await recordReplies(executor, message))) {
    return;
  }
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- Rows go out one at a time, in event order.
    const next = await executor.transaction(() =>
      sendNextRow(executor, message.conversationId, senders),
    );
    if (next.kind === "idle") {
      return;
    }
    if (next.kind === "later") {
      // oxlint-disable-next-line no-await-in-loop -- The loop ends here.
      await publishDelivery(message, { delayMs: next.delayMs });
      return;
    }
  }
}

/**
 * Adds an outbox row for each reply of the Turn that has none. Returns false
 * when the Conversation does not deliver now.
 */
function recordReplies(
  executor: JuniorSqlDatabase,
  message: DeliveryMessage,
): Promise<boolean> {
  return executor.transaction(async () => {
    const db = executor.db();
    const [conversation] = await db
      .select({
        kind: juniorConversations.kind,
        location: juniorConversations.location,
        parentConversationId: juniorConversations.parentConversationId,
      })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, message.conversationId))
      .limit(1);
    if (!conversation) {
      return false;
    }
    const location = conversation.location
      ? locationSchema.parse(conversation.location)
      : undefined;
    if (
      !location ||
      !canPauseConversationDelivery({
        kind: conversationKindFromRow(conversation),
        location,
      }) ||
      (await isConversationDeliveryPaused(message.conversationId))
    ) {
      return false;
    }
    const events = await db
      .select()
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, message.conversationId),
          eq(juniorConversationEvents.type, "assistant_message"),
          like(
            juniorConversationEvents.idempotencyKey,
            `${turnEventKeyPrefix(message.turnId)}%`,
          ),
        ),
      )
      .orderBy(asc(juniorConversationEvents.seq));
    const replies = events.filter((row) => replyText(row) !== undefined);
    if (replies.length > 0) {
      await db
        .insert(juniorTurnOutbox)
        .values(
          replies.map((row) => ({
            id: randomUUID(),
            conversationId: message.conversationId,
            turnId: message.turnId,
            eventSeq: row.seq,
            location,
            state: "pending" as const,
          })),
        )
        .onConflictDoNothing({
          target: [juniorTurnOutbox.conversationId, juniorTurnOutbox.eventSeq],
        });
    }
    return true;
  });
}

type NextRow =
  | { kind: "idle" }
  | { kind: "settled" }
  | { kind: "later"; delayMs: number };

/**
 * Sends the Conversation's first pending row, if this transaction gets the
 * Conversation's lock. A retryable failure leaves the row pending, so the
 * rows after it wait.
 */
async function sendNextRow(
  executor: JuniorSqlDatabase,
  conversationId: string,
  senders: DeliverySenders,
): Promise<NextRow> {
  const db = executor.db();
  const lock = tryLockResultSchema.parse(
    await db.execute(
      sql`select pg_try_advisory_xact_lock(hashtext(${`junior:delivery:${conversationId}`})) as locked`,
    ),
  );
  if (!lock.rows[0].locked) {
    return { kind: "later", delayMs: LOCK_MISS_DELAY_MS };
  }
  const [row] = await db
    .select({
      id: juniorTurnOutbox.id,
      eventSeq: juniorTurnOutbox.eventSeq,
      location: juniorTurnOutbox.location,
      attempts: juniorTurnOutbox.attempts,
    })
    .from(juniorTurnOutbox)
    .where(
      and(
        eq(juniorTurnOutbox.conversationId, conversationId),
        eq(juniorTurnOutbox.state, "pending"),
      ),
    )
    .orderBy(asc(juniorTurnOutbox.eventSeq))
    .limit(1);
  if (!row) {
    return { kind: "idle" };
  }
  const markFailed = async (error: string) => {
    await db
      .update(juniorTurnOutbox)
      .set({ state: "failed", error, updatedAt: new Date() })
      .where(eq(juniorTurnOutbox.id, row.id));
    return { kind: "settled" } as const;
  };
  const location = locationSchema.parse(row.location);
  const send = senders[location.provider];
  if (!send) {
    return markFailed(`No sender for ${location.provider} Locations`);
  }
  const [event] = await db
    .select()
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.seq, row.eventSeq),
      ),
    );
  const text = event ? replyText(event) : undefined;
  if (!text) {
    return markFailed("The event is not a reply");
  }
  try {
    const result = await send({ conversationId, location, text });
    const now = new Date();
    await db
      .update(juniorTurnOutbox)
      .set({
        state: "sent",
        sentAt: now,
        updatedAt: now,
        providerMessageId: result.providerMessageId ?? null,
      })
      .where(eq(juniorTurnOutbox.id, row.id));
    return { kind: "settled" };
  } catch (error) {
    const attempts = row.attempts + 1;
    if (
      error instanceof DeliveryRetryableError &&
      attempts < MAX_DELIVERY_ATTEMPTS
    ) {
      await db
        .update(juniorTurnOutbox)
        .set({ attempts, updatedAt: new Date() })
        .where(eq(juniorTurnOutbox.id, row.id));
      return { kind: "later", delayMs: retryDelayMs(error, attempts) };
    }
    logException(error, "turn.delivery.failed", {
      "gen_ai.conversation.id": conversationId,
    });
    await db
      .update(juniorTurnOutbox)
      .set({
        state: "failed",
        attempts,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      })
      .where(eq(juniorTurnOutbox.id, row.id));
    return { kind: "settled" };
  }
}

/** The text that a message event delivers, or undefined when it is no reply. */
function replyText(
  row: typeof juniorConversationEvents.$inferSelect,
): string | undefined {
  const { data } = eventFromRow(row);
  if (data.type !== "assistant_message") {
    return undefined;
  }
  const message = piMessageFromHistoryItem(data);
  return message.role === "assistant"
    ? getAssistantReplyText(message)
    : undefined;
}

/** The wait before the next try of a retryable send. */
function retryDelayMs(error: DeliveryRetryableError, attempts: number): number {
  return (
    error.retryAfterMs ??
    Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempts - 1), RETRY_MAX_DELAY_MS)
  );
}
