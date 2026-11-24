// Schedules each input that arrives into a Turn. It writes the input once,
// already with its Turn, under the Conversation lock, and publishes a Turn
// only after that transaction commits. A message published before the commit
// can reach a worker that does not see the Turn yet: the claim finds nothing,
// the message is acknowledged, and the Turn never runs. `assignTurn` picks
// which Turn takes the input.
//
// After any change to a Turn, `reconcileTurn` brings delivery and the queue
// in line with the Turn's stored state. It lives here because a failed Turn
// hands on its late inputs through `assignTurn`, and only this file writes
// input rows. Every part of it is safe to repeat, so it needs no marker: every
// path in `advanceTurn` runs it, and a redelivered message runs it again.
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { withConversationEventLock } from "@/chat/conversations/sql/event-lock";
import { publishDelivery } from "@/core/delivery/queue";
import type { EngineContext } from "@/core/engine-context";
import {
  findInputTurn,
  findUnreadInputs,
  type TurnInput,
} from "@/core/turn/inbox";
import { publishTurnStep } from "@/core/turn/queue";
import {
  createTurn,
  findOpenTurn,
  findOpenTurns,
  findTurn,
  type OpenTurn,
  supersedeTurn,
  type Turn,
  TURN_PRIORITY,
  type TurnRecord,
} from "@/core/turn/state";
import { juniorTurnInbox } from "@/db/schema";

/** The Turn that an input went to, and whether the input created it. */
type ScheduleResult = { turnId: string; created: boolean };

type Placement = ScheduleResult & { publish: boolean };

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
 * Junior's rule for which Turn takes an input that is not a duplicate. Core
 * owns it, so every Source schedules the same way. An input joins a Turn only
 * from that Turn's Actor and Source. An interrupt joins the Turn that has
 * started, and an interrupt from anyone else supersedes that Turn. Any input
 * joins the last Turn in line while no step of it has started. Otherwise the
 * input waits in a new Turn at the end of the line, so A1 B1 A2 makes A2 wait
 * for B1. It runs under the Conversation lock, so `openTurns` cannot change
 * before the write.
 */
function assignTurn(
  input: Pick<TurnInput, "actorIdentityId"> & {
    sourceKind: string;
    delivery: MailboxDelivery;
  },
  openTurns: OpenTurn[],
): { join: Turn } | { create: { priority: number }; supersede?: Turn } {
  const sameSender = (turn: OpenTurn) =>
    turn.actorIdentityId === input.actorIdentityId &&
    turn.sourceKind === input.sourceKind;
  const started = openTurns.find((turn) => turn.started);
  if (input.delivery === "interrupt" && started) {
    return sameSender(started)
      ? { join: started }
      : { create: { priority: TURN_PRIORITY.supersede }, supersede: started };
  }
  const last = openTurns.at(-1);
  if (last && !last.started && sameSender(last)) {
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
      publish: existing.state === "queued",
    };
  }
  const openTurns = await findOpenTurns({ executor }, input.conversationId);
  const choice = assignTurn(
    { ...input, sourceKind: input.source.kind, delivery },
    openTurns,
  );
  if ("join" in choice) {
    const { turnId } = choice.join;
    await addInput({ executor }, { ...input, turnId });
    return { turnId, created: false, publish: false };
  }
  if (choice.supersede) {
    await supersedeTurn({ executor }, choice.supersede.turnId);
  }
  const turn = await createTurn(
    { executor },
    {
      conversationId: input.conversationId,
      actorIdentityId: input.actorIdentityId,
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
    publish: openTurns.length === 0 || choice.supersede !== undefined,
  };
}

/**
 * Puts an input into the Turn that `assignTurn` picks, and publishes a Turn
 * that the input created when no other Turn is open or when it supersedes
 * one. An input with a known idempotency key writes nothing. Call it outside
 * a transaction: it publishes after its own commit, and a publish error
 * reaches the caller with the input already stored.
 */
export async function scheduleInput(
  { executor, queue }: Pick<EngineContext, "executor" | "queue">,
  input: TurnInput & { delivery: MailboxDelivery },
): Promise<ScheduleResult> {
  const placement = await withConversationEventLock(
    executor,
    input.conversationId,
    () => placeInput({ executor }, input),
  );
  if (placement.publish) {
    await publishTurnStep({ queue }, placement.turnId);
  }
  return { turnId: placement.turnId, created: placement.created };
}

// Not exported, like addInput: only reconcileTurn moves inputs, under the
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
 * failed Turn's Actor and Source, so they move together. The failed Turn
 * keeps, and so drops, the inputs that an attempt claimed it with.
 */
async function moveLeftovers(
  { executor }: Pick<EngineContext, "executor">,
  ended: TurnRecord,
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
            actorIdentityId: first.actorIdentityId,
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
 * Brings delivery and the queue in line with this Turn's stored state. Safe
 * to repeat. It publishes the Turn's delivery message, moves a failed Turn's
 * inputs that arrived after its last claim, then publishes the Conversation's
 * open Turn if it is queued. What it does depends only on the stored state,
 * not on why it runs. Call it outside a transaction: it publishes after its
 * own commit.
 */
export async function reconcileTurn(
  { executor, queue }: Pick<EngineContext, "executor" | "queue">,
  turnId: string,
): Promise<void> {
  const turn = await findTurn({ executor }, turnId);
  if (!turn) {
    return;
  }
  await publishDelivery(
    { queue },
    {
      conversationId: turn.conversationId,
      turnId,
    },
  );
  const openTurn = await withConversationEventLock(
    executor,
    turn.conversationId,
    async () => {
      if (turn.state === "failed") {
        await moveLeftovers({ executor }, turn);
      }
      return findOpenTurn({ executor }, turn.conversationId);
    },
  );
  // A Turn that a step commit continued is the queued open Turn, so this also
  // sends its next step. A running Turn has a worker, so it needs no message.
  if (openTurn?.state === "queued") {
    await publishTurnStep({ queue }, openTurn.turnId);
  }
}
