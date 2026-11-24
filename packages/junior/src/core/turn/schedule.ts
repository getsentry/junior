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
  findTurn,
  type Turn,
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
 * Junior's rule for which Turn takes an input that is not a duplicate. Core
 * owns it, so every Source schedules the same way. Later rules, such as
 * superseding a Turn or checking for the same Actor, go here. It runs under
 * the Conversation lock, so `openTurn`, the Conversation's queued or running
 * Turn if any, cannot change before the write.
 */
function assignTurn(
  openTurn: Turn | undefined,
): { join: Turn } | { create: { priority: number } } {
  return openTurn ? { join: openTurn } : { create: { priority: 0 } };
}

async function placeInput(
  { executor }: Pick<EngineContext, "executor">,
  input: TurnInput,
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
  const choice = assignTurn(
    await findOpenTurn({ executor }, input.conversationId),
  );
  if ("join" in choice) {
    const { turnId } = choice.join;
    await addInput({ executor }, { ...input, turnId });
    return { turnId, created: false, publish: false };
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
  return { turnId: turn.turnId, created: true, publish: true };
}

/**
 * Puts an input into the Turn that `assignTurn` picks, and publishes a Turn
 * that the input created. An input with a known idempotency key writes
 * nothing. Call it outside a transaction: it publishes after its own commit,
 * and a publish error reaches the caller with the input already stored.
 */
export async function scheduleInput(
  { executor, queue }: Pick<EngineContext, "executor" | "queue">,
  input: TurnInput,
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
 * to the Turn that `assignTurn` picks. The failed Turn keeps, and so drops,
 * the inputs that an attempt claimed it with.
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
    await findOpenTurn({ executor }, ended.conversationId),
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
