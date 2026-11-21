// Schedules each input that arrives into a Turn. It writes the input once,
// already with its Turn, under the Conversation lock, and publishes a Turn
// only after that transaction commits. A message published before the commit
// can reach a worker that does not see the Turn yet: the claim finds nothing,
// the message is acknowledged, and the Turn never runs. The caller's
// `assignTurn` picks which Turn takes the input.
import { randomUUID } from "node:crypto";
import type { Source } from "@sentry/junior-plugin-api";
import { withConversationEventLock } from "@/chat/conversations/sql/event-lock";
import { findInputTurn, type TurnInput } from "@/core/turn/inbox";
import { publishTurnStep } from "@/core/turn/queue";
import { createTurn, findOpenTurn, type Turn } from "@/core/turn/state";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorTurnInbox } from "@/db/schema";

/**
 * A `TurnInput` with the kind of the Source that sent it. A Turn that the
 * input creates keeps that Source.
 */
type IncomingTurnInput = TurnInput & { source: Source["kind"] };

/** The Turn that an input went to, and whether the input created it. */
type ScheduleResult = { turnId: string; created: boolean };

type ScheduleOptions = {
  /**
   * Chooses the Turn of an input that is not a duplicate: join the open
   * Turn of the Conversation, or create a Turn with a priority. It runs
   * under the Conversation lock, so `openTurn` cannot change before the write.
   * `openTurn` is the Conversation's queued or running Turn, if any.
   * It only picks the Turn; core writes the input.
   */
  assignTurn: (
    openTurn: Turn | undefined,
    input: IncomingTurnInput,
  ) => { join: string } | { create: { priority: number } };
};

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

async function placeInput(
  executor: JuniorSqlDatabase,
  input: IncomingTurnInput,
  { assignTurn }: ScheduleOptions,
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
  const openTurn = await findOpenTurn(executor, input.conversationId);
  const choice = assignTurn(openTurn, input);
  if ("join" in choice) {
    if (choice.join !== openTurn?.turnId) {
      throw new Error(
        `assignTurn joined Turn ${choice.join}, but the open Turn is ${openTurn?.turnId ?? "none"}`,
      );
    }
    await addInput(executor, { ...inboxInput, turnId: openTurn.turnId });
    return { turnId: openTurn.turnId, created: false, publish: false };
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
  options: ScheduleOptions,
): Promise<ScheduleResult> {
  const placement = await withConversationEventLock(
    executor,
    input.conversationId,
    () => placeInput(executor, input, options),
  );
  if (placement.publish) {
    await publishTurnStep(placement.turnId);
  }
  return { turnId: placement.turnId, created: placement.created };
}
