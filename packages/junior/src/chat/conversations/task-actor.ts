/**
 * Task Actor: the Actor whose work one Turn is.
 *
 * Each Turn records its task Actor in its `turn_started` event. A Turn takes
 * it from the Turn that caused it:
 *
 * - A Turn from a person or an Automation run has its own Actor.
 * - A child Turn from `spawnAgent` or `messageAgent` has the task Actor of the
 *   parent Turn that made the call.
 * - A Turn from a Watch has the task Actor of the Turn that created the Watch.
 * - A Turn from a child result or agent message has the task Actor of the
 *   child Turn that sent it.
 *
 * The event system Actor is never a task Actor. When no causing Turn gives a
 * task Actor, the Turn has none. The task Actor only selects whose root
 * messages give user approval. It never selects the Run Actor or credentials.
 */
import type { Actor } from "@/chat/actor";
import { getConversationEventStore } from "@/chat/db";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import type { TurnReference } from "./history";
import { sameActorIdentity } from "./provenance";

/**
 * Return the task Actor of a Turn that a person or an Automation run started
 * as `actor`. The event system Actor is not a task Actor.
 */
export function taskActorForActor(actor: Actor | undefined): Actor | undefined {
  return actor && !sameActorIdentity(actor, EVENT_SYSTEM_ACTOR)
    ? actor
    : undefined;
}

/** Read the task Actor that one Turn recorded when it started. */
export async function loadTurnTaskActor(
  turn: TurnReference,
): Promise<Actor | undefined> {
  const event = await getConversationEventStore().loadByIdempotencyKey(
    turn.conversationId,
    `turn:${turn.turnId}:started`,
  );
  return event?.data.type === "turn_started" &&
    event.data.turnId === turn.turnId
    ? event.data.taskActor
    : undefined;
}

/**
 * Return the Turn that caused work with several inputs, and its task Actor.
 * Each input must name a causing Turn, and each causing Turn must have the
 * same task Actor. Otherwise nothing is returned.
 */
export async function resolveCausingTurn(
  causes: ReadonlyArray<TurnReference | undefined>,
): Promise<{ taskActor: Actor; turn: TurnReference } | undefined> {
  const [first] = causes;
  if (!first || causes.some((cause) => !cause)) {
    return undefined;
  }
  const actors = await Promise.all(
    causes.map(async (cause) => await loadTurnTaskActor(cause!)),
  );
  const taskActor = actors[0];
  if (!taskActor || !actors.every((a) => sameActorIdentity(a, taskActor))) {
    return undefined;
  }
  return { taskActor, turn: first };
}
