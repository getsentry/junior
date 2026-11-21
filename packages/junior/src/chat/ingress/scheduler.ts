// The scheduler puts each input that arrives into a Turn. It writes the input
// once, already with its Turn, under the Conversation lock, and publishes a
// Turn only after that transaction commits. A message published before the
// commit can reach a worker that does not see the Turn yet: the claim finds
// nothing, the message is acknowledged, and the Turn never runs.
import type { Source } from "@sentry/junior-plugin-api";
import { withConversationEventLock } from "@/chat/conversations/sql/event-lock";
import { addInput, findInputTurn, type Input } from "@/core/turn/inbox";
import { publishTurnStep } from "@/core/turn/queue";
import { createTurn, findOpenTurn } from "@/core/turn/state";
import type { JuniorSqlDatabase } from "@/db/db";

/** An input with the kind of the Source it came from. */
type ArrivingInput = Input & { source: Source["kind"] };

/** The Turn that an input went to, and whether the input started it. */
type ScheduledInput = { turnId: string; created: boolean };

type Placement = ScheduledInput & { publish: boolean };

async function placeInput(
  executor: JuniorSqlDatabase,
  input: ArrivingInput,
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
  const open = await findOpenTurn(executor, input.conversationId);
  if (open) {
    await addInput(executor, { ...inboxInput, turnId: open.turnId });
    return { turnId: open.turnId, created: false, publish: false };
  }
  const turn = await createTurn(executor, {
    conversationId: input.conversationId,
    actorIdentityId: input.actorIdentityId,
    source,
    priority: 0,
  });
  await addInput(executor, { ...inboxInput, turnId: turn.turnId });
  return { turnId: turn.turnId, created: true, publish: true };
}

/**
 * Puts an input into the open Turn of its Conversation, or into a new Turn
 * that it then publishes. An input with a known idempotency key writes
 * nothing. Call it outside a transaction: it publishes after its own commit,
 * and a publish error reaches the caller with the input already stored.
 */
export async function scheduleInput(
  executor: JuniorSqlDatabase,
  input: ArrivingInput,
): Promise<ScheduledInput> {
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
