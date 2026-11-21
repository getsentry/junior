// Schedules each input that arrives into a Turn. It writes the input once,
// already with its Turn, under the Conversation lock, and publishes a Turn
// only after that transaction commits. A message published before the commit
// can reach a worker that does not see the Turn yet: the claim finds nothing,
// the message is acknowledged, and the Turn never runs. `assignTurn` picks
// which Turn takes the input.
//
// When a Turn ends, `turnEnded` moves a failed Turn's inputs that no model
// step was given to the Turn that `assignTurn` picks, then publishes the
// Conversation's queued Turn. Every part of it is safe to repeat, so it needs
// no marker: it runs on every end path, and again on a redelivery.
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { Source } from "@sentry/junior-plugin-api";
import { withConversationEventLock } from "@/chat/conversations/sql/event-lock";
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
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorTurnInbox } from "@/db/schema";

/**
 * A `TurnInput` with the kind of the Source that sent it. A Turn that the
 * input creates keeps that Source.
 */
type IncomingTurnInput = TurnInput & { source: Source["kind"] };

/** The Turn that an input went to, and whether the input created it. */
type ScheduleResult = { turnId: string; created: boolean };

type Placement = ScheduleResult & { publish: boolean };

// Not exported: scheduleInput is the only writer, so every input row is
// written under the Conversation lock.
async function addInput(
  executor: JuniorSqlDatabase,
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
  executor: JuniorSqlDatabase,
  input: IncomingTurnInput,
): Promise<Placement> {
  const { source, ...inboxInput } = input;
  const existing = await findInputTurn(executor, input);
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
  const choice = assignTurn(await findOpenTurn(executor, input.conversationId));
  if ("join" in choice) {
    const { turnId } = choice.join;
    await addInput(executor, { ...inboxInput, turnId });
    return { turnId, created: false, publish: false };
  }
  const turn = await createTurn(executor, {
    conversationId: input.conversationId,
    actorIdentityId: input.actorIdentityId,
    source,
    priority: choice.create.priority,
  });
  await addInput(executor, { ...inboxInput, turnId: turn.turnId });
  return { turnId: turn.turnId, created: true, publish: true };
}

/**
 * Puts an input into the Turn that `assignTurn` picks, and publishes a Turn
 * that the input created. An input with a known idempotency key writes
 * nothing. Call it outside a transaction: it publishes after its own commit,
 * and a publish error reaches the caller with the input already stored.
 */
export async function scheduleInput(
  executor: JuniorSqlDatabase,
  input: IncomingTurnInput,
): Promise<ScheduleResult> {
  const placement = await withConversationEventLock(
    executor,
    input.conversationId,
    () => placeInput(executor, input),
  );
  if (placement.publish) {
    await publishTurnStep(placement.turnId);
  }
  return { turnId: placement.turnId, created: placement.created };
}

// Not exported, like addInput: only turnEnded moves inputs, under the
// Conversation lock. A row keeps its id and idempotency key.
async function moveInputs(
  executor: JuniorSqlDatabase,
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
 * Moves the unread inputs of a failed Turn that no model step was given to
 * the Turn that `assignTurn` picks. The failed Turn keeps, and so drops, the
 * inputs that a step was given.
 */
async function moveLeftovers(
  executor: JuniorSqlDatabase,
  ended: TurnRecord,
): Promise<void> {
  const leftovers = (await findUnreadInputs(executor, ended.turnId)).filter(
    (input) => input.attemptedAt === null,
  );
  const [first] = leftovers;
  if (!first) {
    return;
  }
  const choice = assignTurn(await findOpenTurn(executor, ended.conversationId));
  const target =
    "join" in choice
      ? choice.join
      : await createTurn(executor, {
          conversationId: ended.conversationId,
          actorIdentityId: first.actorIdentityId,
          source: ended.source,
          priority: choice.create.priority,
        });
  await moveInputs(
    executor,
    leftovers.map((input) => input.inputId),
    target.turnId,
  );
}

/**
 * The end work of a Turn: a failed Turn hands on its inputs that no model
 * step was given, then the Conversation's queued Turn is published. It does
 * nothing for a Turn that has not ended. Safe to run any number of times.
 * Call it outside a transaction: it publishes after its own commit.
 */
export async function turnEnded(
  executor: JuniorSqlDatabase,
  turnId: string,
): Promise<void> {
  const ended = await findTurn(executor, turnId);
  if (!ended || ended.state === "queued" || ended.state === "running") {
    return;
  }
  const openTurn = await withConversationEventLock(
    executor,
    ended.conversationId,
    async () => {
      if (ended.state === "failed") {
        await moveLeftovers(executor, ended);
      }
      return findOpenTurn(executor, ended.conversationId);
    },
  );
  if (openTurn?.state === "queued") {
    await publishTurnStep(openTurn.turnId);
  }
}
