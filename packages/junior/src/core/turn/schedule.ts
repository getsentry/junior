// Schedules each input that arrives into a Turn. It writes the input once,
// already with its Turn, under the Conversation lock, and publishes a Turn
// only after that transaction commits. A message published before the commit
// can reach a worker that does not see the Turn yet: the claim finds nothing,
// the message is acknowledged, and the Turn never runs. `assignTurn` picks
// which Turn takes the input.
//
// After any change to a Turn, `reconcileTurn` brings the queue in line with
// the Turn's stored state. It lives here because a failed Turn hands on its
// late inputs through `assignTurn`, and only this file writes input rows.
// Every part of it is safe to repeat, so it needs no marker: every path in
// `advanceTurn` runs it, and a redelivered message runs it again.
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { AgentTurnUsage } from "@/chat/usage";
import { withConversationEventLock } from "@/conversation-events/lock";
import { publishTurnEnded } from "@/core/turn/ended";
import type { EngineContext } from "@/core/engine-context";
import {
  findInputTurn,
  findUnreadInputs,
  type TurnInput,
} from "@/core/turn/inbox";
import { publishTurnStep } from "@/core/turn/queue";
import {
  createTurn,
  failTurn,
  findOpenTurn,
  findOpenTurns,
  findTurn,
  type OpenTurn,
  supersedeTurn,
  type Turn,
  type TurnFailure,
  type TurnLease,
  TURN_PRIORITY,
} from "@/core/turn/state";
import { juniorTurnInbox } from "@/db/schema";

/** The Turn an input went to, and whether it created the Turn or was known. */
type ScheduleResult = { turnId: string; created: boolean; duplicate: boolean };

type Placement = ScheduleResult & {
  publish: boolean;
  /** A queued Turn that the input superseded, which ended now. */
  ended?: string;
};

// Not exported: scheduleInput is the only writer, so every input row is
// written under the Conversation lock.
async function addInput(
  { executor }: Pick<EngineContext, "executor">,
  input: TurnInput & { turnId: string },
): Promise<void> {
  await executor
    .db()
    .insert(juniorTurnInbox)
    .values({ ...input, id: randomUUID() });
}

/**
 * How an input that arrives during a Turn is handled: `interrupt` joins the
 * running Turn at its next step, `defer` waits for a Turn of its own.
 */
export type MailboxDelivery = "interrupt" | "defer";

/**
 * The rule for which Turn takes an input that is not a duplicate. Core owns
 * it, so every Source schedules the same way, and the host decides who may
 * share a Turn through the group key. An input joins a Turn only when its
 * group key matches. An interrupt joins the Turn that has started, and an
 * interrupt with another group key supersedes that Turn. Any input
 * joins the last Turn in line while no step of it has started. Otherwise the
 * input waits in a new Turn at the end of the line, so A1 B1 A2 makes A2 wait
 * for B1. It runs under the Conversation lock, so `openTurns` cannot change
 * before the write.
 */
function assignTurn(
  input: Pick<TurnInput, "groupKey"> & { delivery: MailboxDelivery },
  openTurns: OpenTurn[],
): { join: Turn } | { create: { priority: number }; supersede?: Turn } {
  const sameGroup = (turn: OpenTurn) => turn.groupKey === input.groupKey;
  const started = openTurns.find((turn) => turn.started);
  if (input.delivery === "interrupt" && started) {
    return sameGroup(started)
      ? { join: started }
      : { create: { priority: TURN_PRIORITY.supersede }, supersede: started };
  }
  const last = openTurns.at(-1);
  if (last && !last.started && sameGroup(last)) {
    return { join: last };
  }
  return { create: { priority: TURN_PRIORITY.normal } };
}

async function placeInput(
  { executor }: Pick<EngineContext, "executor">,
  { delivery, ...input }: TurnInput & { delivery: MailboxDelivery },
): Promise<Placement> {
  const existing = await findInputTurn({ executor }, input);
  if (existing) {
    // The source retries after a publish that failed after the commit. The
    // Turn then waits queued with no message, so publish it again. A second
    // message for a Turn is safe: its claim finds the Turn already taken.
    return {
      turnId: existing.turnId,
      created: false,
      duplicate: true,
      publish: existing.state === "queued",
    };
  }
  const openTurns = await findOpenTurns({ executor }, input.conversationId);
  const choice = assignTurn({ ...input, delivery }, openTurns);
  if ("join" in choice) {
    const { turnId } = choice.join;
    await addInput({ executor }, { ...input, turnId });
    return { turnId, created: false, duplicate: false, publish: false };
  }
  const ended =
    choice.supersede &&
    (await supersedeTurn({ executor }, choice.supersede.turnId))
      ? choice.supersede.turnId
      : undefined;
  const turn = await createTurn(
    { executor },
    {
      conversationId: input.conversationId,
      priority: choice.create.priority,
    },
  );
  await addInput({ executor }, { ...input, turnId: turn.turnId });
  // A Turn behind another one gets its message from `reconcileTurn` when the
  // Turn before it ends. A Turn that supersedes one is next as soon as the
  // superseded Turn ends, which may be now.
  return {
    turnId: turn.turnId,
    created: true,
    duplicate: false,
    publish: openTurns.length === 0 || choice.supersede !== undefined,
    ended,
  };
}

/**
 * Puts an input into the Turn that `assignTurn` picks, then publishes what
 * the placement calls for, such as the end of a Turn it superseded. A known
 * idempotency key writes nothing. Call it outside a transaction: it publishes
 * after its own commit, so a publish error leaves the input stored.
 * `startDelayMs` holds the Turn that this publishes, so later inputs join it.
 */
export async function scheduleInput(
  { executor, queue }: Pick<EngineContext, "executor" | "queue">,
  {
    startDelayMs,
    ...input
  }: TurnInput & {
    delivery: MailboxDelivery;
    startDelayMs?: number | undefined;
  },
): Promise<ScheduleResult> {
  const placement = await withConversationEventLock(
    executor,
    input.conversationId,
    () => placeInput({ executor }, input),
  );
  if (placement.ended) {
    await publishTurnEnded(
      { queue },
      { conversationId: input.conversationId, turnId: placement.ended },
    );
  }
  if (placement.publish) {
    await publishTurnStep(
      { queue },
      placement.turnId,
      startDelayMs ? { delayMs: startDelayMs } : {},
    );
  }
  return {
    turnId: placement.turnId,
    created: placement.created,
    duplicate: placement.duplicate,
  };
}

// Not exported, like addInput: only endFailedTurn moves inputs, under the
// Conversation lock. A row keeps its id and idempotency key.
async function moveInputs(
  { executor }: Pick<EngineContext, "executor">,
  inputIds: string[],
  turnId: string,
): Promise<void> {
  await executor
    .db()
    .update(juniorTurnInbox)
    .set({ turnId })
    .where(inArray(juniorTurnInbox.id, inputIds));
}

/**
 * Moves the unread inputs of a failed Turn that arrived after its last claim
 * to the Turn that `assignTurn` picks for a deferred input. They share the
 * failed Turn's group key, so they move together. The failed Turn
 * keeps, and so drops, the inputs that an attempt claimed it with.
 */
async function moveLeftovers(
  { executor }: Pick<EngineContext, "executor">,
  ended: { turnId: string; conversationId: string },
): Promise<void> {
  const leftovers = (await findUnreadInputs({ executor }, ended.turnId)).filter(
    (input) => input.attemptedAt === null,
  );
  const [first] = leftovers;
  if (!first) {
    return;
  }
  const choice = assignTurn(
    { ...first, delivery: "defer" },
    await findOpenTurns({ executor }, ended.conversationId),
  );
  const target =
    "join" in choice
      ? choice.join
      : await createTurn(
          { executor },
          {
            conversationId: ended.conversationId,
            priority: choice.create.priority,
          },
        );
  await moveInputs(
    { executor },
    leftovers.map((input) => input.inputId),
    target.turnId,
  );
}

/**
 * Ends a running Turn as failed and, in the same commit, moves its inputs
 * that arrived after its last claim to the next Turn. A crash after the
 * commit loses no input: the next Turn is queued, so the sweep finds it.
 * `discarded` is the usage of a failed model reply that the Turn drops.
 * False when the lease is lost, and then nothing changes.
 */
export async function endFailedTurn(
  { executor }: Pick<EngineContext, "executor">,
  lease: TurnLease & { conversationId: string },
  endReason: string,
  failure: TurnFailure,
  discarded?: AgentTurnUsage,
): Promise<boolean> {
  return executor.transaction(() =>
    withConversationEventLock(executor, lease.conversationId, async () => {
      if (
        !(await failTurn({ executor }, lease, endReason, failure, discarded))
      ) {
        return false;
      }
      await moveLeftovers({ executor }, lease);
      return true;
    }),
  );
}

/**
 * Brings the queue in line with this Turn's stored state, so it is safe to
 * repeat: it says the Turn ended if it has, then publishes the Conversation's
 * open Turn if it is queued. Call it after the commit that it follows,
 * outside a transaction, so a worker that takes a message sees that commit.
 */
export async function reconcileTurn(
  { executor, queue }: Pick<EngineContext, "executor" | "queue">,
  turnId: string,
): Promise<void> {
  const turn = await findTurn({ executor }, turnId);
  if (!turn) {
    return;
  }
  if (turn.state !== "queued" && turn.state !== "running") {
    await publishTurnEnded(
      { queue },
      { conversationId: turn.conversationId, turnId },
    );
  }
  const openTurn = await findOpenTurn({ executor }, turn.conversationId);
  // A Turn that a step commit continued is the queued open Turn, so this also
  // sends its next step. A running Turn has a worker, so it needs no message.
  if (openTurn?.state === "queued") {
    await publishTurnStep({ queue }, openTurn.turnId);
  }
}
