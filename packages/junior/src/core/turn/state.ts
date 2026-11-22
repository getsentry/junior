// The state changes of a Turn. Each arrow is one function in this file.
//
//            claimTurn            commitStep (completed)
//   queued ─────────────▶ running ───────────────────────▶ completed
//     │   ◀─────────────    │  ↺ claimTurn (lease expired)
//     │   commitStep        │
//     │   (continue),       │                failTurn
//     │   releaseTurn       ├──────────────────────────▶ failed
//     │     cancelTurn      │   cancelTurn
//     └─────────────────────┴──────────────────────────▶ cancelled
//
// createTurn inserts a Turn as queued. completed, failed and cancelled are
// final: no function changes them. A lease covers one step: commitStep
// (continue) queues the Turn again, and the next step needs a new claim.
//
// | Change                 | Turn must be          | lease_epoch | attempts | step_seq | Lease    |
// | ---------------------- | --------------------- | ----------- | -------- | -------- | -------- |
// | claimTurn              | queued, or expired    | +1          | +1       |          | set      |
// | commitStep (continue)  | running, fenced, step |             | 0        | +1       | cleared  |
// | commitStep (completed) | running, fenced, step |             | 0        | +1       | cleared  |
// | failTurn               | running, fenced       |             |          |          | cleared  |
// | releaseTurn            | running, fenced       |             |          |          | cleared  |
// | cancelTurn             | queued or running     | +1          |          |          | cleared  |
//
// commitStep (completed) queues the Turn instead, like commitStep (continue),
// while the Turn has an input that no step has read.
//
// cancelTurn publishes the Turn after the cancel. That message claims nothing,
// so the step consumer runs `reconcileTurn` for it.
//
// This file is the only writer of a Turn's lifecycle events, in the same
// transaction as the state change they record, as main's readers expect:
// `turn_started` with the first commit that reads inputs, `turn_completed`
// with the commit that completes the Turn or with cancelTurn, and
// `turn_failed` with failTurn. Their idempotency keys write each one once.
//
// Expired: running, but `lease_expires_at` has passed. Only claimTurn takes
// over such a Turn, so the queue's redelivery after a crash resumes it.
//
// Fenced: the write matches only while the Turn runs under the caller's
// `lease_epoch`, so a worker that lost its lease changes nothing and gets
// `false`, or undefined from commitStep. holdsLease reads the same fence
// without a write. Step: the write
// also matches only at the caller's claimed `step_seq`, so a second commit of
// the same step changes nothing. Lease times use the database clock, so hosts
// agree on expiry.
//
// commitStep, failTurn and cancelTurn take the Conversation lock before they
// touch the Turn row. A writer that needs both takes them in this order, so
// writers cannot deadlock.
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { Source } from "@sentry/junior-plugin-api";
import type {
  ConversationTurnFailureCode,
  NewConversationEvent,
} from "@/chat/conversations/history";
import { contextProvenance } from "@/chat/conversations/provenance";
import { withConversationEventLock } from "@/chat/conversations/sql/event-lock";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { historyItemFromPiMessage } from "@/chat/pi/conversation-events";
import {
  findUnreadInputs,
  inputEventKey,
  type InputMessage,
} from "@/core/turn/inbox";
import { publishTurnStep } from "@/core/turn/queue";
import { findTurnReplies, turnEventKeyPrefix } from "@/core/turn/replies";
import type { StepResult } from "@/core/turn/step";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorTurnInbox, juniorTurns } from "@/db/schema";
import type { TurnState } from "@/db/schema/turns";

/** A Turn's id and state. */
export type Turn = { turnId: string; state: TurnState };

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

type TurnStartedData = Extract<
  NewConversationEvent["data"],
  { type: "turn_started" }
>;

// The surface of main's `turn_started`, from the Turn's Source kind, the way
// main's runs pick one: dispatches and automations are `api`, and runs that
// Junior starts itself are `internal`.
const TURN_SURFACES: Record<Source["kind"], TurnStartedData["surface"]> = {
  slack: "slack",
  web: "api",
  plugin_dispatch: "api",
  scheduled_automation: "api",
  event_automation: "api",
  event: "internal",
  local: "internal",
  agent_invocation: "internal",
};

/**
 * A lifecycle event of a Turn. Its idempotency key matches main's, so a Turn
 * has one `started` and one `terminal` event however often a write repeats.
 */
function lifecycleEvent(
  turnId: string,
  mark: "started" | "terminal",
  data: NewConversationEvent["data"],
): NewConversationEvent {
  return {
    idempotencyKey: `turn:${turnId}:${mark}`,
    createdAtMs: Date.now(),
    data,
  };
}

/**
 * Inserts a queued Turn. It sends no step message: the caller publishes the
 * Turn after its transaction commits, so a worker can claim it.
 */
export async function createTurn(
  executor: JuniorSqlDatabase,
  args: {
    conversationId: string;
    actorIdentityId: string;
    source: Source["kind"];
    priority: number;
  },
): Promise<Turn> {
  const turnId = randomUUID();
  await executor
    .db()
    .insert(juniorTurns)
    .values({ ...args, id: turnId, state: "queued" });
  return { turnId, state: "queued" };
}

/** A Turn with the facts that `reconcileTurn` needs. */
export type TurnRecord = Turn & {
  conversationId: string;
  source: Source["kind"];
  actorIdentityId: string;
};

/** Finds a Turn by id. Undefined when it does not exist. */
export async function findTurn(
  executor: JuniorSqlDatabase,
  turnId: string,
): Promise<TurnRecord | undefined> {
  const [turn] = await executor
    .db()
    .select({
      turnId: juniorTurns.id,
      state: juniorTurns.state,
      conversationId: juniorTurns.conversationId,
      source: juniorTurns.source,
      actorIdentityId: juniorTurns.actorIdentityId,
    })
    .from(juniorTurns)
    .where(eq(juniorTurns.id, turnId));
  return turn;
}

/**
 * Finds the Turn of a Conversation that has not ended: the running Turn, else
 * the next queued Turn by priority and age.
 */
export async function findOpenTurn(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<Turn | undefined> {
  const [turn] = await executor
    .db()
    .select({ turnId: juniorTurns.id, state: juniorTurns.state })
    .from(juniorTurns)
    .where(
      and(
        eq(juniorTurns.conversationId, conversationId),
        inArray(juniorTurns.state, ["queued", "running"]),
      ),
    )
    .orderBy(
      sql`${juniorTurns.state} = 'running' desc`,
      asc(juniorTurns.priority),
      asc(juniorTurns.createdAt),
    )
    .limit(1);
  return turn;
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
 * caller's `lease_epoch`. False after a cancel or a takeover.
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
 * The idempotency key of one message event of a step. It names the Turn and
 * the step that wrote it, so Delivery finds a Turn's replies without reading
 * the rest of the history.
 */
function stepEventKey(turnId: string, stepSeq: number, index: number): string {
  return `${turnEventKeyPrefix(turnId)}${stepSeq}:${index}`;
}

/**
 * Commits a step in one transaction: it appends the inputs that the step
 * read, then the step's messages keyed by Turn and step, to the Conversation
 * history and releases the lease. It also writes `turn_started` with the
 * first inputs and `turn_completed` when the Turn ends. A Turn that continues
 * goes back to queued for its next step, which needs a new claim. A Turn that
 * the step completed ends, unless it still has unread inputs: then it
 * continues, so the next step reads them.
 * Returns what the Turn does next. Undefined when the lease is lost or the
 * step is already committed, and then nothing is written.
 */
export async function commitStep(
  executor: JuniorSqlDatabase,
  turn: TurnLease & { conversationId: string; stepSeq: number },
  step: Extract<StepResult, { outcome: "continue" | "completed" }>,
  inputs: InputMessage[],
): Promise<"continue" | "completed" | undefined> {
  const nextStep = {
    stepSeq: sql`${juniorTurns.stepSeq} + 1`,
    attempts: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: sql`now()`,
  };
  return executor.transaction(() =>
    withConversationEventLock(executor, turn.conversationId, async () => {
      const outcome = await commitOutcome(executor, turn.turnId, step, inputs);
      const rows = await executor
        .db()
        .update(juniorTurns)
        .set(
          outcome === "completed"
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
        .returning({ source: juniorTurns.source });
      const [committed] = rows;
      if (!committed) {
        return undefined;
      }
      const events = createSqlConversationEventStore(executor);
      // `turn_started` goes before the inputs: main's readers take the user
      // messages after it as the Turn's input.
      await events.append(turn.conversationId, [
        ...(await turnStartedEvents(executor, turn, committed.source, inputs)),
        ...inputs.map(({ inputId, message, provenance }) => ({
          data: historyItemFromPiMessage(message, provenance),
          idempotencyKey: inputEventKey(inputId),
          createdAtMs: message.timestamp,
        })),
        ...step.messages.map((message, index) => ({
          data: historyItemFromPiMessage(message, contextProvenance),
          idempotencyKey: stepEventKey(turn.turnId, turn.stepSeq, index),
          createdAtMs: message.timestamp,
        })),
      ]);
      if (outcome === "completed") {
        // Main's `success` means the Turn has a reply to deliver.
        const replies = await findTurnReplies(
          executor,
          turn.conversationId,
          turn.turnId,
        );
        await events.append(turn.conversationId, [
          lifecycleEvent(turn.turnId, "terminal", {
            type: "turn_completed",
            turnId: turn.turnId,
            outcome: replies.length > 0 ? "success" : "no_reply",
          }),
        ]);
      }
      return outcome;
    }),
  );
}

/**
 * The `turn_started` event of a commit that reads inputs. Main lists the
 * Source's message ids, so it lists each input's idempotency key. Only the
 * first such commit writes it: later ones repeat its idempotency key.
 */
async function turnStartedEvents(
  executor: JuniorSqlDatabase,
  turn: TurnLease,
  source: Source["kind"],
  inputs: InputMessage[],
): Promise<NewConversationEvent[]> {
  if (inputs.length === 0) {
    return [];
  }
  const rows = await executor
    .db()
    .select({ id: juniorTurnInbox.id, key: juniorTurnInbox.idempotencyKey })
    .from(juniorTurnInbox)
    .where(
      inArray(
        juniorTurnInbox.id,
        inputs.map((input) => input.inputId),
      ),
    );
  const keys = new Map(rows.map((row) => [row.id, row.key]));
  return [
    lifecycleEvent(turn.turnId, "started", {
      type: "turn_started",
      turnId: turn.turnId,
      inputMessageIds: inputs.flatMap((input) => keys.get(input.inputId) ?? []),
      surface: TURN_SURFACES[source],
    }),
  ];
}

/**
 * A completed step ends the Turn only when the commit reads every unread
 * input. The scheduler can add an input after the step read them, and the
 * Conversation lock keeps more out until the commit ends.
 */
async function commitOutcome(
  executor: JuniorSqlDatabase,
  turnId: string,
  step: Extract<StepResult, { outcome: "continue" | "completed" }>,
  inputs: InputMessage[],
): Promise<"continue" | "completed"> {
  if (step.outcome === "continue") {
    return "continue";
  }
  const read = new Set(inputs.map((input) => input.inputId));
  const unread = await findUnreadInputs(executor, turnId);
  return unread.every((input) => read.has(input.inputId))
    ? "completed"
    : "continue";
}

/**
 * Ends a running Turn as failed, with the reason, and writes `turn_failed`
 * with main's failure code. False when the lease is lost.
 */
export async function failTurn(
  executor: JuniorSqlDatabase,
  lease: TurnLease & { conversationId: string },
  endReason: string,
  failureCode: ConversationTurnFailureCode,
): Promise<boolean> {
  return executor.transaction(() =>
    withConversationEventLock(executor, lease.conversationId, async () => {
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
        .where(
          and(
            leaseFence(lease),
            eq(juniorTurns.conversationId, lease.conversationId),
          ),
        )
        .returning({ id: juniorTurns.id });
      if (rows.length === 0) {
        return false;
      }
      await createSqlConversationEventStore(executor).append(
        lease.conversationId,
        [
          lifecycleEvent(lease.turnId, "terminal", {
            type: "turn_failed",
            turnId: lease.turnId,
            failureCode,
          }),
        ],
      );
      return true;
    }),
  );
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
 * Cancels a queued or running Turn, and writes main's `turn_completed` with
 * the outcome `cancelled`. It needs no lease. It moves `lease_epoch`, so the
 * invocation that runs the step cannot commit it. After the cancel it
 * publishes the Turn: that message claims nothing and runs `reconcileTurn`.
 * False when the Turn has already ended.
 */
export async function cancelTurn(
  executor: JuniorSqlDatabase,
  turnId: string,
): Promise<boolean> {
  const turn = await findTurn(executor, turnId);
  if (!turn) {
    return false;
  }
  const cancelled = await executor.transaction(() =>
    withConversationEventLock(executor, turn.conversationId, async () => {
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
      if (rows.length === 0) {
        return false;
      }
      await createSqlConversationEventStore(executor).append(
        turn.conversationId,
        [
          lifecycleEvent(turnId, "terminal", {
            type: "turn_completed",
            turnId,
            outcome: "cancelled",
          }),
        ],
      );
      return true;
    }),
  );
  if (!cancelled) {
    return false;
  }
  await publishTurnStep(turnId);
  return true;
}
