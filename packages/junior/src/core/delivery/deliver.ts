// Delivery of a Turn's replies to the Destination of its inputs. The commit
// of a step writes an outbox row for each reply (see `recordReplies`), and
// each change of a Turn publishes a delivery message (see `reconcileTurn`).
// Its consumer sends the Conversation's pending rows in event order under a
// lock on the Conversation. Each send commits its own row, so a crash sends
// at most that one reply again.
import { and, asc, eq, sql } from "drizzle-orm";
import * as z from "zod";
import { destinationSchema, type Destination } from "@sentry/junior-plugin-api";
import { logException } from "@/chat/logging";
import { publishDelivery, type DeliveryMessage } from "@/core/delivery/queue";
import type { EngineContext } from "@/core/engine-context";
import { replyText } from "@/core/turn/replies";
import { juniorConversationEvents, juniorTurnOutbox } from "@/db/schema";

/** What the host gives core to deliver a Turn's replies. */
export type Delivery = {
  /**
   * Sends one reply to its Destination. It throws `DeliveryRetryableError`
   * when a later try can work, and any other error when it cannot.
   */
  send: (reply: {
    conversationId: string;
    destination: Destination;
    text: string;
  }) => Promise<{ providerMessageId?: string }>;
};

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
 * Sends the Conversation's pending outbox rows in event order, each to the
 * Destination stored on its row.
 */
export async function deliverTurn(
  { executor, queue }: Pick<EngineContext, "executor" | "queue">,
  message: DeliveryMessage,
  delivery: Delivery,
): Promise<void> {
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- Rows go out one at a time, in event order.
    const next = await executor.transaction(() =>
      sendNextRow({ executor }, message.conversationId, delivery),
    );
    if (next.kind === "idle") {
      return;
    }
    if (next.kind === "later") {
      // oxlint-disable-next-line no-await-in-loop -- The loop ends here.
      await publishDelivery({ queue }, message, { delayMs: next.delayMs });
      return;
    }
  }
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
  { executor }: Pick<EngineContext, "executor">,
  conversationId: string,
  delivery: Pick<Delivery, "send">,
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
      destination: juniorTurnOutbox.destination,
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
  const destination = destinationSchema.parse(row.destination);
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
    const result = await delivery.send({ conversationId, destination, text });
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

/** The wait before the next try of a retryable send. */
function retryDelayMs(error: DeliveryRetryableError, attempts: number): number {
  return (
    error.retryAfterMs ??
    Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempts - 1), RETRY_MAX_DELAY_MS)
  );
}
