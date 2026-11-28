// The state changes of a Turn, one function each: claimTurn runs a queued
// Turn, or takes over a running one whose lease expired. commitStep completes
// it or queues it again (continue), as releaseTurn does. failTurn fails it.
// stopTurns cancels a queued or running Turn. completed, failed and cancelled
// are final. A lease covers one step.
import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type {
  ConversationTurnFailureCode,
  ConversationTurnFailureReason,
} from "@/chat/conversations/history";
import { contextProvenance } from "@/chat/conversations/provenance";
import { extractGenAiUsageSummary } from "@/chat/logging";
import {
  addAgentTurnUsage,
  agentTurnCostUsd,
  type AgentTurnUsage,
} from "@/chat/usage";
import { withConversationEventLock } from "@/conversation-events/lock";
import { historyItemFromPiMessage } from "@/core/history/items";
import { appendAgentHistory } from "@/core/history/write";
import type { EngineContext } from "@/core/engine-context";
import type { PromptMessage } from "@/core/prompt/assemble";
import { publishTurnEnded } from "@/core/turn/ended";
import { findUnreadInputs, inputEventKey } from "@/core/turn/inbox";
import { recordReplies } from "@/core/turn/outbox";
import { turnEventKeyPrefix } from "@/core/turn/replies";
import type { StepResult } from "@/core/turn/step";
import { juniorTurnInbox, juniorTurns } from "@/db/schema";
import type { TurnState } from "@/db/schema/turns";
import { usdToMicroUsd } from "@/db/micro-usd";
import { usageTokensSchema, type UsageTokens } from "@/usage-schema";

/** A Turn's id and state. */
export type Turn = { turnId: string; state: TurnState };

/**
 * Turn priorities: a lower number runs first. A Turn that supersedes the
 * running Turn runs before every other queued Turn.
 */
export const TURN_PRIORITY = { supersede: 0, normal: 1 } as const;

const SUPERSEDED_END = {
  state: "cancelled",
  endReason: "superseded",
  endedAt: sql`now()`,
} as const;

/**
 * The lease of one invocation on one step of a Turn. A fenced write matches
 * only while the Turn runs under this `lease_epoch`, so a worker that lost its
 * lease changes nothing. A commit also matches only at the claimed
 * `step_seq`, so a second commit of the same step changes nothing.
 */
export type TurnLease = { turnId: string; leaseEpoch: number };

/** A Turn that one invocation claimed to run its next step. */
export type ClaimedTurn = TurnLease & {
  conversationId: string;
  stepSeq: number;
  /** Claims of this step so far, including this one. */
  attempts: number;
};

// Writers take the Conversation lock before the Turn row, in that order, so
// they cannot deadlock, and a claim cannot start a Turn while `scheduleInput`
// decides where an input goes. Lease times use the database clock, so hosts
// agree on expiry.
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
 * Inserts a queued Turn. It sends no step message: the caller publishes the
 * Turn after its transaction commits, so a worker can claim it.
 */
export async function createTurn(
  { executor }: Pick<EngineContext, "executor">,
  args: {
    conversationId: string;
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

/**
 * Why a Turn failed, in main's failure labels: where it stopped, the provider
 * error kind when a model request failed, and the Sentry event of the failure.
 */
export type TurnFailure = {
  failureCode: ConversationTurnFailureCode;
  failureReason?: ConversationTurnFailureReason;
  eventId?: string;
};

/** A Turn with the facts that `reconcileTurn` needs, and its failure. */
export type TurnRecord = Turn & {
  conversationId: string;
  failureCode: ConversationTurnFailureCode | null;
  failureReason: ConversationTurnFailureReason | null;
  failureEventId: string | null;
  /** When the Turn started running. Null if it never ran. */
  startedAt: Date | null;
  /** When the Turn ended. Null while it's queued or running. */
  endedAt: Date | null;
};

/** Finds a Turn by id. Undefined when it does not exist. */
export async function findTurn(
  { executor }: Pick<EngineContext, "executor">,
  turnId: string,
): Promise<TurnRecord | undefined> {
  const [turn] = await executor
    .db()
    .select({
      turnId: juniorTurns.id,
      state: juniorTurns.state,
      conversationId: juniorTurns.conversationId,
      failureCode: juniorTurns.failureCode,
      failureReason: juniorTurns.failureReason,
      failureEventId: juniorTurns.failureEventId,
      startedAt: juniorTurns.startedAt,
      endedAt: juniorTurns.endedAt,
    })
    .from(juniorTurns)
    .where(eq(juniorTurns.id, turnId));
  return turn;
}

/** The usage of the model replies that a Turn paid for but did not keep. */
export type DiscardedUsage = { costMicroUsd: number; tokens?: UsageTokens };

/** Reads a Turn's discarded usage. Undefined when the Turn does not exist. */
export async function findDiscardedUsage(
  { executor }: Pick<EngineContext, "executor">,
  turnId: string,
): Promise<DiscardedUsage | undefined> {
  return selectDiscardedUsage({ executor }, eq(juniorTurns.id, turnId));
}

async function selectDiscardedUsage(
  { executor }: Pick<EngineContext, "executor">,
  where: SQL | undefined,
): Promise<DiscardedUsage | undefined> {
  const [turn] = await executor
    .db()
    .select({
      costMicroUsd: juniorTurns.discardedCostMicroUsd,
      tokens: juniorTurns.discardedTokens,
    })
    .from(juniorTurns)
    .where(where);
  if (!turn) {
    return undefined;
  }
  return turn.tokens === null
    ? { costMicroUsd: turn.costMicroUsd }
    : {
        costMicroUsd: turn.costMicroUsd,
        tokens: usageTokensSchema.parse(turn.tokens),
      };
}

// The columns that add `usage` to the Turn's discarded usage, for the fenced
// update that releases or ends the Turn. Only the lease holder writes them,
// so it can read and add here instead of in SQL.
async function discardedUsageUpdate(
  { executor }: Pick<EngineContext, "executor">,
  lease: TurnLease,
  usage: AgentTurnUsage | undefined,
): Promise<{ discardedCostMicroUsd?: number; discardedTokens?: UsageTokens }> {
  const current = usage
    ? await selectDiscardedUsage({ executor }, leaseFence(lease))
    : undefined;
  if (!current) {
    return {};
  }
  const { cost: _, ...tokens } = addAgentTurnUsage(current.tokens, usage) ?? {};
  return {
    discardedCostMicroUsd:
      current.costMicroUsd + usdToMicroUsd(agentTurnCostUsd(usage) ?? 0),
    discardedTokens: tokens,
  };
}

// Run order of a Conversation's open Turns: the running Turn first, then
// queued Turns by priority, age and id. claimTurn's `next` rule matches it.
const runOrder = [
  sql`${juniorTurns.state} = 'running' desc`,
  asc(juniorTurns.priority),
  asc(juniorTurns.createdAt),
  asc(juniorTurns.id),
];

/**
 * Finds the Turn of a Conversation that has not ended: the running Turn, else
 * the next queued Turn by priority and age.
 */
export async function findOpenTurn(
  { executor }: Pick<EngineContext, "executor">,
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
    .orderBy(...runOrder)
    .limit(1);
  return turn;
}

/** A Turn that has not ended, with the group key of its inputs. */
export type OpenTurn = Turn & {
  groupKey: string;
  /** True once any step of the Turn has been claimed. */
  started: boolean;
};

/**
 * Finds the Turns of a Conversation that can still take inputs, in run order:
 * those that have not ended, less a running Turn that another Turn
 * supersedes.
 */
export async function findOpenTurns(
  { executor }: Pick<EngineContext, "executor">,
  conversationId: string,
): Promise<OpenTurn[]> {
  // Grouping by group key gives one row per Turn, because a database
  // constraint keeps the inputs of a Turn on one group key.
  const rows = await executor
    .db()
    .select({
      turnId: juniorTurns.id,
      state: juniorTurns.state,
      groupKey: juniorTurnInbox.groupKey,
      stepSeq: juniorTurns.stepSeq,
      attempts: juniorTurns.attempts,
    })
    .from(juniorTurns)
    .innerJoin(juniorTurnInbox, eq(juniorTurnInbox.turnId, juniorTurns.id))
    .where(
      and(
        eq(juniorTurns.conversationId, conversationId),
        or(
          eq(juniorTurns.state, "queued"),
          and(
            eq(juniorTurns.state, "running"),
            notExists(turnAhead({ executor })),
          ),
        ),
      ),
    )
    .groupBy(juniorTurns.id, juniorTurnInbox.groupKey)
    .orderBy(...runOrder);
  return rows.map(({ stepSeq, attempts, ...turn }) => ({
    ...turn,
    started: stepSeq > 0 || attempts > 0,
  }));
}

// Another Turn of the outer Turn's Conversation that runs, or that is queued
// before it in run order.
function turnAhead({ executor }: Pick<EngineContext, "executor">) {
  const ahead = alias(juniorTurns, "ahead");
  return executor
    .db()
    .select({ one: sql`1` })
    .from(ahead)
    .where(
      and(
        eq(ahead.conversationId, juniorTurns.conversationId),
        ne(ahead.id, juniorTurns.id),
        or(
          eq(ahead.state, "running"),
          and(
            eq(ahead.state, "queued"),
            sql`(${ahead.priority}, ${ahead.createdAt}, ${ahead.id}) < (${juniorTurns.priority}, ${juniorTurns.createdAt}, ${juniorTurns.id})`,
          ),
        ),
      ),
    );
}

// A Turn that `supersedeTurn` moved behind another Turn. It ends at its next
// commit or release instead of queuing again.
async function isSuperseded(
  { executor }: Pick<EngineContext, "executor">,
  turnId: string,
): Promise<boolean> {
  const rows = await executor
    .db()
    .select({ id: juniorTurns.id })
    .from(juniorTurns)
    .where(and(eq(juniorTurns.id, turnId), exists(turnAhead({ executor }))));
  return rows.length > 0;
}

/**
 * Makes way for a Turn that supersedes this one. Call it under the
 * Conversation lock. A queued Turn has no step in flight, so it ends now and
 * moves `lease_epoch`. A running Turn moves behind the new Turn, and
 * `commitStep` or `releaseTurn` ends it, so the step's work is kept. True
 * when the Turn ended now.
 */
export async function supersedeTurn(
  { executor }: Pick<EngineContext, "executor">,
  turnId: string,
): Promise<boolean> {
  const db = executor.db();
  const ended = await db
    .update(juniorTurns)
    .set({
      ...SUPERSEDED_END,
      leaseEpoch: sql`${juniorTurns.leaseEpoch} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(juniorTurns.id, turnId), eq(juniorTurns.state, "queued")))
    .returning({ id: juniorTurns.id });
  await db
    .update(juniorTurns)
    .set({ priority: TURN_PRIORITY.normal, updatedAt: sql`now()` })
    .where(and(eq(juniorTurns.id, turnId), eq(juniorTurns.state, "running")));
  return ended.length > 0;
}

/**
 * Claims a Turn to run its next step: the Conversation's next queued Turn, or
 * a running Turn whose lease expired, so the queue's redelivery after a crash
 * resumes it. Any other Turn gets undefined, so one of two racing claims wins,
 * and a Conversation runs one Turn at a time, in order. Each claim moves
 * `lease_epoch` and `attempts` and holds the Conversation lock.
 */
export async function claimTurn(
  {
    executor,
    owner,
    leaseMs,
  }: Pick<EngineContext, "executor" | "owner" | "leaseMs">,
  turnId: string,
): Promise<ClaimedTurn | undefined> {
  const turn = await findTurn({ executor }, turnId);
  if (!turn) {
    return undefined;
  }
  const claim = () =>
    executor
      .db()
      .update(juniorTurns)
      .set({
        state: "running",
        leaseOwner: owner,
        leaseExpiresAt: leaseExpiry(leaseMs),
        leaseEpoch: sql`${juniorTurns.leaseEpoch} + 1`,
        attempts: sql`${juniorTurns.attempts} + 1`,
        startedAt: sql`coalesce(${juniorTurns.startedAt}, now())`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(juniorTurns.id, turnId),
          or(
            and(
              eq(juniorTurns.state, "queued"),
              notExists(turnAhead({ executor })),
            ),
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
  const [claimed] = await executor.transaction(() =>
    withConversationEventLock(executor, turn.conversationId, claim),
  );
  return claimed;
}

/**
 * Checks without a write that the lease still holds: the Turn runs under the
 * caller's `lease_epoch`. False after a cancel or a takeover.
 */
export async function holdsLease(
  { executor }: Pick<EngineContext, "executor">,
  lease: TurnLease,
): Promise<boolean> {
  const rows = await executor
    .db()
    .select({ id: juniorTurns.id })
    .from(juniorTurns)
    .where(leaseFence(lease));
  return rows.length > 0;
}

/** A Turn that no queue message will touch again. */
type StalledTurn = {
  turnId: string;
  conversationId: string;
  reason: "queued_lost" | "lease_expired";
  stalledMs: number;
};

/**
 * Finds Turns that a claim could take now but that no message is likely to
 * reach: the next queued Turn of its Conversation, unchanged for `staleMs`,
 * and running Turns whose lease expired `staleMs` ago. The queue redelivers
 * a dead step's message soon after its lease expires, so only a Turn that
 * missed that redelivery is stalled.
 */
export async function findStalledTurns(
  { executor }: Pick<EngineContext, "executor">,
  { staleMs, limit }: { staleMs: number; limit: number },
): Promise<StalledTurn[]> {
  const staleBefore = sql`now() - make_interval(secs => ${staleMs / 1000})`;
  const rows = await executor
    .db()
    .select({
      turnId: juniorTurns.id,
      conversationId: juniorTurns.conversationId,
      state: juniorTurns.state,
      updatedAt: juniorTurns.updatedAt,
      leaseExpiresAt: juniorTurns.leaseExpiresAt,
    })
    .from(juniorTurns)
    .where(
      or(
        and(
          eq(juniorTurns.state, "queued"),
          lt(juniorTurns.updatedAt, staleBefore),
          notExists(turnAhead({ executor })),
        ),
        and(
          eq(juniorTurns.state, "running"),
          lt(juniorTurns.leaseExpiresAt, staleBefore),
        ),
      ),
    )
    .limit(limit);
  const nowMs = Date.now();
  return rows.map((row) => {
    const since =
      row.state === "running" && row.leaseExpiresAt
        ? row.leaseExpiresAt
        : row.updatedAt;
    return {
      turnId: row.turnId,
      conversationId: row.conversationId,
      reason: row.state === "running" ? "lease_expired" : "queued_lost",
      stalledMs: Math.max(0, nowMs - since.getTime()),
    };
  });
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
 * The idempotency key of one new message that a step's prompt added from a
 * message fragment. It is not a step event key, so Delivery does not read it.
 */
function promptEventKey(
  turnId: string,
  stepSeq: number,
  index: number,
): string {
  return `prompt:${turnId}:${stepSeq}:${index}`;
}

/**
 * Commits a step in one transaction: appends the prompt's new messages, with
 * the inputs the step read, then the step's messages to history, adds an
 * outbox row per new reply, and releases the lease. A Turn that continues
 * queues for a new claim. A `stale` final reply is not committed. Undefined,
 * with no write, when the lease is lost or the step is already committed.
 */
export async function commitStep(
  { executor }: Pick<EngineContext, "executor">,
  turn: TurnLease & { conversationId: string; stepSeq: number },
  step: Extract<StepResult, { outcome: "continue" | "completed" }>,
  prompt: PromptMessage[],
): Promise<"continue" | "completed" | "superseded" | "stale" | undefined> {
  const nextStep = {
    stepSeq: sql`${juniorTurns.stepSeq} + 1`,
    attempts: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: sql`now()`,
  };
  return executor.transaction(() =>
    withConversationEventLock(executor, turn.conversationId, async () => {
      const outcome = await commitOutcome(
        { executor },
        turn.turnId,
        step,
        prompt,
      );
      if (outcome === "stale") {
        return (await requeueStep({ executor }, turn, step))
          ? outcome
          : undefined;
      }
      const rows = await executor
        .db()
        .update(juniorTurns)
        .set(
          outcome === "completed"
            ? { ...nextStep, state: "completed", endedAt: sql`now()` }
            : outcome === "superseded"
              ? { ...nextStep, ...SUPERSEDED_END }
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
        return undefined;
      }
      await appendAgentHistory(executor, turn.conversationId, turn.turnId, [
        ...prompt.map((entry, index) =>
          entry.source === "input"
            ? {
                item: historyItemFromPiMessage(entry.message, entry.provenance),
                idempotencyKey: inputEventKey(entry.inputId),
                createdAtMs: entry.message.timestamp,
              }
            : {
                item: historyItemFromPiMessage(
                  entry.message,
                  contextProvenance,
                ),
                idempotencyKey: promptEventKey(
                  turn.turnId,
                  turn.stepSeq,
                  index,
                ),
                createdAtMs: entry.message.timestamp,
              },
        ),
        ...step.messages.map((message, index) => ({
          item: historyItemFromPiMessage(message, contextProvenance),
          idempotencyKey: stepEventKey(turn.turnId, turn.stepSeq, index),
          createdAtMs: message.timestamp,
        })),
      ]);
      await recordReplies({ executor }, turn);
      return outcome;
    }),
  );
}

/**
 * A completed step ends the Turn only when the commit reads every unread
 * input. The scheduler can add an input after the step read them, and the
 * Conversation lock keeps more out until the commit ends. A final reply that
 * missed an input is `stale`, so the Turn ends with one reply to every input.
 */
async function commitOutcome(
  { executor }: Pick<EngineContext, "executor">,
  turnId: string,
  step: Extract<StepResult, { outcome: "continue" | "completed" }>,
  prompt: PromptMessage[],
): Promise<"continue" | "completed" | "superseded" | "stale"> {
  if (step.outcome === "completed") {
    const read = new Set(
      prompt.flatMap((entry) =>
        entry.source === "input" ? [entry.inputId] : [],
      ),
    );
    const unread = await findUnreadInputs({ executor }, turnId);
    if (unread.every((input) => read.has(input.inputId))) {
      return "completed";
    }
  }
  // A superseded Turn's unread inputs stay on it and are dropped, so its
  // final reply is the last answer that it gives.
  if (await isSuperseded({ executor }, turnId)) {
    return "superseded";
  }
  // A tool batch already ran its tools, so only a model reply is dropped.
  return step.outcome === "completed" && finalReplyOf(step)
    ? "stale"
    : "continue";
}

function finalReplyOf(
  step: Extract<StepResult, { outcome: "continue" | "completed" }>,
): AssistantMessage | undefined {
  const [message] = step.messages;
  return message?.role === "assistant" ? message : undefined;
}

/**
 * Queues the Turn for the same step again, with nothing committed, after a
 * stale final reply. The attempt does not count: the step did not fail. The
 * dropped reply's usage adds to the Turn's discarded usage.
 */
async function requeueStep(
  { executor }: Pick<EngineContext, "executor">,
  turn: TurnLease & { conversationId: string; stepSeq: number },
  step: Extract<StepResult, { outcome: "continue" | "completed" }>,
): Promise<boolean> {
  const rows = await executor
    .db()
    .update(juniorTurns)
    .set({
      ...(await discardedUsageUpdate(
        { executor },
        turn,
        extractGenAiUsageSummary(finalReplyOf(step)),
      )),
      state: "queued",
      attempts: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        leaseFence(turn),
        eq(juniorTurns.conversationId, turn.conversationId),
        eq(juniorTurns.stepSeq, turn.stepSeq),
      ),
    )
    .returning({ id: juniorTurns.id });
  return rows.length > 0;
}

/**
 * Ends a running Turn as failed, with the reason and the failure details.
 * `discarded` is the usage of the model reply that the step drops. False when
 * the lease is lost. The engine calls it through `endFailedTurn`, which also
 * moves the Turn's late inputs.
 */
export async function failTurn(
  { executor }: Pick<EngineContext, "executor">,
  lease: TurnLease,
  endReason: string,
  failure: TurnFailure,
  discarded?: AgentTurnUsage,
): Promise<boolean> {
  const rows = await executor
    .db()
    .update(juniorTurns)
    .set({
      ...(await discardedUsageUpdate({ executor }, lease, discarded)),
      state: "failed",
      endReason,
      failureCode: failure.failureCode,
      failureReason: failure.failureReason ?? null,
      failureEventId: failure.eventId ?? null,
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
 * retry can claim the step at once. The failed attempt still counts. A Turn
 * that another Turn supersedes ends instead, like at a commit. `discarded` is
 * the usage of the failed model reply that the retry drops. Returns the
 * Turn's new state, or undefined when the lease is lost.
 */
export async function releaseTurn(
  { executor }: Pick<EngineContext, "executor">,
  lease: TurnLease & { conversationId: string },
  discarded?: AgentTurnUsage,
): Promise<TurnState | undefined> {
  return executor.transaction(() =>
    withConversationEventLock(executor, lease.conversationId, async () => {
      const released = {
        ...(await discardedUsageUpdate({ executor }, lease, discarded)),
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: sql`now()`,
      };
      const rows = await executor
        .db()
        .update(juniorTurns)
        .set(
          (await isSuperseded({ executor }, lease.turnId))
            ? { ...released, ...SUPERSEDED_END }
            : { ...released, state: "queued" },
        )
        .where(leaseFence(lease))
        .returning({ state: juniorTurns.state });
      return rows[0]?.state;
    }),
  );
}

/**
 * Cancels every queued and running Turn of a Conversation in one commit, with
 * no lease. Moving each `lease_epoch` keeps a running step from committing,
 * and the lock sends a later input to a new Turn. It then publishes the
 * message that each stopped Turn ended.
 */
export async function stopTurns(
  { executor, queue }: Pick<EngineContext, "executor" | "queue">,
  conversationId: string,
): Promise<string[]> {
  const stopped = await executor.transaction(() =>
    withConversationEventLock(executor, conversationId, () =>
      executor
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
            eq(juniorTurns.conversationId, conversationId),
            inArray(juniorTurns.state, ["queued", "running"]),
          ),
        )
        .returning({ id: juniorTurns.id }),
    ),
  );
  for (const { id } of stopped) {
    // oxlint-disable-next-line no-await-in-loop -- Few Turns stop at once, and a failed send fails the stop.
    await publishTurnEnded({ queue }, { conversationId, turnId: id });
  }
  return stopped.map(({ id }) => id);
}
