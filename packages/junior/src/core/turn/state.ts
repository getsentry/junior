// The state changes of a Turn. Each change is one fenced write. A write by the
// lease holder matches only while the Turn runs under the same `lease_epoch`,
// so a worker that lost its lease changes nothing and gets `false`. Lease
// times use the database clock, so invocations on different hosts agree.
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorTurns } from "@/db/schema";

/** The lease of one invocation on one step of a Turn. */
export type TurnLease = { turnId: string; leaseEpoch: number };

/** A Turn that one invocation claimed to run its next step. */
export type ClaimedTurn = TurnLease & {
  stepSeq: number;
  /** Claims of this step so far, including this one. */
  attempts: number;
};

function leaseExpiry(leaseMs: number) {
  return sql`now() + ${leaseMs}::integer * interval '1 millisecond'`;
}

function holdsLease(lease: TurnLease) {
  return and(
    eq(juniorTurns.id, lease.turnId),
    eq(juniorTurns.state, "running"),
    eq(juniorTurns.leaseEpoch, lease.leaseEpoch),
  );
}

/**
 * Claims a queued Turn to run its next step. Returns undefined when the Turn
 * is not queued, so of two concurrent claims only one gets the Turn.
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
      and(eq(juniorTurns.id, args.turnId), eq(juniorTurns.state, "queued")),
    )
    .returning({
      turnId: juniorTurns.id,
      leaseEpoch: juniorTurns.leaseEpoch,
      stepSeq: juniorTurns.stepSeq,
      attempts: juniorTurns.attempts,
    });
  return claimed;
}

/** Extends the lease by `leaseMs` from now. False when the lease is lost. */
export async function heartbeat(
  executor: JuniorSqlDatabase,
  lease: TurnLease,
  leaseMs: number,
): Promise<boolean> {
  const rows = await executor
    .db()
    .update(juniorTurns)
    .set({ leaseExpiresAt: leaseExpiry(leaseMs), updatedAt: sql`now()` })
    .where(holdsLease(lease))
    .returning({ id: juniorTurns.id });
  return rows.length > 0;
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
    .where(holdsLease(lease))
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
    .where(holdsLease(lease))
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
