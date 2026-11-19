// The state changes of a Turn. Each arrow is one function in this file.
//
//            claimTurn            completeTurn, commitStep (completed)
//   queued ─────────────▶ running ─────────────────────────────────▶ completed
//     │   ◀─────────────    │  ↺ claimTurn (lease expired)
//     │   commitStep        │
//     │   (continue),       │                failTurn
//     │   releaseTurn,      ├──────────────────────────▶ failed
//     │   reclaimExpired    │
//     │   (lease expired)   │
//     │     cancelTurn      │   cancelTurn
//     └─────────────────────┴──────────────────────────▶ cancelled
//
// A Turn starts as queued. completed, failed and cancelled are final: no
// function changes them. A lease covers one step: commitStep (continue) queues
// the Turn again, and the next step needs a new claim.
//
// | Change                 | Turn must be          | lease_epoch | attempts | step_seq | Lease    |
// | ---------------------- | --------------------- | ----------- | -------- | -------- | -------- |
// | claimTurn              | queued, or expired    | +1          | +1       |          | set      |
// | commitStep (continue)  | running, fenced, step |             | 0        | +1       | cleared  |
// | commitStep (completed) | running, fenced, step |             | 0        | +1       | cleared  |
// | completeTurn           | running, fenced       |             |          |          | cleared  |
// | failTurn               | running, fenced       |             |          |          | cleared  |
// | releaseTurn            | running, fenced       |             |          |          | cleared  |
// | cancelTurn             | queued or running     | +1          |          |          | cleared  |
// | reclaimExpired         | running, expired      |             |          |          | cleared  |
//
// Expired: running, but `lease_expires_at` has passed. claimTurn takes over
// such a Turn, so the queue's redelivery after a crash resumes it.
//
// Fenced: the write matches only while the Turn runs under the caller's
// `lease_epoch`, so a worker that lost its lease changes nothing and gets
// `false`. holdsLease reads the same fence without a write. Step: the write
// also matches only at the caller's claimed `step_seq`, so a second commit of
// the same step changes nothing. Lease times use the database clock, so hosts
// agree on expiry.
//
// commitStep takes the Conversation lock before it touches the Turn row. A
// writer that needs both takes them in this order, so writers cannot deadlock.
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import { contextProvenance } from "@/chat/conversations/provenance";
import { withConversationEventLock } from "@/chat/conversations/sql/event-lock";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { historyItemFromPiMessage } from "@/chat/pi/conversation-events";
import type { StepResult } from "@/core/turn/step";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorTurns } from "@/db/schema";

/** The lease of one invocation on one step of a Turn. */
export type TurnLease = { turnId: string; leaseEpoch: number };

/** A Turn that one invocation claimed to run its next step. */
export type ClaimedTurn = TurnLease & {
  conversationId: string;
  stepSeq: number;
  /** Claims of this step so far, including this one. */
  attempts: number;
};

function leaseExpiry(leaseMs: number) {
  return sql`now() + ${leaseMs}::integer * interval '1 millisecond'`;
}

function leaseFence(lease: TurnLease) {
  return and(
    eq(juniorTurns.id, lease.turnId),
    eq(juniorTurns.state, "running"),
    eq(juniorTurns.leaseEpoch, lease.leaseEpoch),
  );
}

/**
 * Claims a Turn to run its next step: a queued Turn, or a running Turn whose
 * lease expired. Returns undefined for any other Turn, so of two concurrent
 * claims only one gets the Turn.
 */
export async function claimTurn(
  executor: JuniorSqlDatabase,
  args: { turnId: string; owner: string; leaseMs: number },
): Promise<ClaimedTurn | undefined> {
  const [claimed] = await executor
    .db()
    .update(juniorTurns)
    .set({
      state: "running",
      leaseOwner: args.owner,
      leaseExpiresAt: leaseExpiry(args.leaseMs),
      leaseEpoch: sql`${juniorTurns.leaseEpoch} + 1`,
      attempts: sql`${juniorTurns.attempts} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(juniorTurns.id, args.turnId),
        or(
          eq(juniorTurns.state, "queued"),
          and(
            eq(juniorTurns.state, "running"),
            lte(juniorTurns.leaseExpiresAt, sql`now()`),
          ),
        ),
      ),
    )
    .returning({
      turnId: juniorTurns.id,
      leaseEpoch: juniorTurns.leaseEpoch,
      conversationId: juniorTurns.conversationId,
      stepSeq: juniorTurns.stepSeq,
      attempts: juniorTurns.attempts,
    });
  return claimed;
}

/**
 * Checks without a write that the lease still holds: the Turn runs under the
 * caller's `lease_epoch`. False after a cancel, a takeover, or a reclaim.
 */
export async function holdsLease(
  executor: JuniorSqlDatabase,
  lease: TurnLease,
): Promise<boolean> {
  const rows = await executor
    .db()
    .select({ id: juniorTurns.id })
    .from(juniorTurns)
    .where(leaseFence(lease));
  return rows.length > 0;
}

/**
 * Commits a step in one transaction: it appends the step's messages to the
 * Conversation history and releases the lease. A Turn that continues goes
 * back to queued for its next step, which needs a new claim. A Turn that the
 * step completed ends. False when the lease is lost or the step is already
 * committed, and then nothing is written.
 */
export async function commitStep(
  executor: JuniorSqlDatabase,
  turn: TurnLease & { conversationId: string; stepSeq: number },
  step: Extract<StepResult, { outcome: "continue" | "completed" }>,
): Promise<boolean> {
  const nextStep = {
    stepSeq: sql`${juniorTurns.stepSeq} + 1`,
    attempts: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: sql`now()`,
  };
  return executor.transaction(() =>
    withConversationEventLock(executor, turn.conversationId, async () => {
      const rows = await executor
        .db()
        .update(juniorTurns)
        .set(
          step.outcome === "completed"
            ? { ...nextStep, state: "completed", endedAt: sql`now()` }
            : { ...nextStep, state: "queued" },
        )
        .where(
          and(
            leaseFence(turn),
            eq(juniorTurns.conversationId, turn.conversationId),
            eq(juniorTurns.stepSeq, turn.stepSeq),
          ),
        )
        .returning({ id: juniorTurns.id });
      if (rows.length === 0) {
        return false;
      }
      await createSqlConversationEventStore(executor).append(
        turn.conversationId,
        step.messages.map((message) => ({
          data: historyItemFromPiMessage(message, contextProvenance),
          createdAtMs: message.timestamp,
        })),
      );
      return true;
    }),
  );
}

/** Ends a running Turn as completed. False when the lease is lost. */
export async function completeTurn(
  executor: JuniorSqlDatabase,
  lease: TurnLease,
): Promise<boolean> {
  const rows = await executor
    .db()
    .update(juniorTurns)
    .set({
      state: "completed",
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: sql`now()`,
      endedAt: sql`now()`,
    })
    .where(leaseFence(lease))
    .returning({ id: juniorTurns.id });
  return rows.length > 0;
}

/** Ends a running Turn as failed, with the reason. False when the lease is lost. */
export async function failTurn(
  executor: JuniorSqlDatabase,
  lease: TurnLease,
  endReason: string,
): Promise<boolean> {
  const rows = await executor
    .db()
    .update(juniorTurns)
    .set({
      state: "failed",
      endReason,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: sql`now()`,
      endedAt: sql`now()`,
    })
    .where(leaseFence(lease))
    .returning({ id: juniorTurns.id });
  return rows.length > 0;
}

/**
 * Queues a running Turn again after its invocation failed, so the queue's
 * retry can claim the step at once. The failed attempt still counts. False
 * when the lease is lost.
 */
export async function releaseTurn(
  executor: JuniorSqlDatabase,
  lease: TurnLease,
): Promise<boolean> {
  const rows = await executor
    .db()
    .update(juniorTurns)
    .set({
      state: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: sql`now()`,
    })
    .where(leaseFence(lease))
    .returning({ id: juniorTurns.id });
  return rows.length > 0;
}

/**
 * Cancels a queued or running Turn. It needs no lease. It moves
 * `lease_epoch`, so the invocation that runs the step cannot commit it.
 * False when the Turn has already ended.
 */
export async function cancelTurn(
  executor: JuniorSqlDatabase,
  turnId: string,
): Promise<boolean> {
  const rows = await executor
    .db()
    .update(juniorTurns)
    .set({
      state: "cancelled",
      leaseEpoch: sql`${juniorTurns.leaseEpoch} + 1`,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: sql`now()`,
      endedAt: sql`now()`,
    })
    .where(
      and(
        eq(juniorTurns.id, turnId),
        inArray(juniorTurns.state, ["queued", "running"]),
      ),
    )
    .returning({ id: juniorTurns.id });
  return rows.length > 0;
}

/**
 * Queues each running Turn whose lease expired, so a sweeper can send it
 * through the queue again. Returns their ids. The next claim moves
 * `lease_epoch`, and until then the old lease holder's writes find no running
 * Turn.
 */
export async function reclaimExpired(
  executor: JuniorSqlDatabase,
): Promise<string[]> {
  const rows = await executor
    .db()
    .update(juniorTurns)
    .set({
      state: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(juniorTurns.state, "running"),
        lte(juniorTurns.leaseExpiresAt, sql`now()`),
      ),
    )
    .returning({ id: juniorTurns.id });
  return rows.map((row) => row.id);
}
