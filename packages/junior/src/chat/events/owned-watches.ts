/**
 * Watch ownership for the watch tools. A Conversation owns its own watches and
 * the watches of every child agent below it, at any depth. A child agent still
 * manages its own watches. It never owns the watches of its parent or of a
 * sibling. Delivery does not change: each watch still wakes the Conversation
 * that created it.
 */
import {
  listDescendantAgents,
  type DescendantAgent,
} from "@/chat/agent-invocations/list";
import { getWatch, listWatches, type Watch } from "@/chat/events/store";

/** An active watch and the child agent that created it, if not the owner. */
export type OwnedWatch = {
  /** Absent when the current Conversation created the watch. */
  childAgent?: DescendantAgent;
  watch: Watch;
};

/** List the active watches that one Conversation owns, oldest first. */
export async function listOwnedWatches(
  conversationId: string,
): Promise<OwnedWatch[]> {
  const [own, childAgents] = await Promise.all([
    listWatches({ conversationId }),
    listDescendantAgents(conversationId),
  ]);
  const childWatches = await Promise.all(
    childAgents.map(async (childAgent) =>
      (await listWatches({ conversationId: childAgent.conversationId })).map(
        (watch) => ({ childAgent, watch }),
      ),
    ),
  );
  return [...own.map((watch) => ({ watch })), ...childWatches.flat()].sort(
    (left, right) => left.watch.createdAtMs - right.watch.createdAtMs,
  );
}

/**
 * Find one watch by id in any status. Returns undefined when the Conversation
 * does not own it.
 */
export async function findOwnedWatch(input: {
  conversationId: string;
  id: string;
}): Promise<Watch | undefined> {
  const watch = await getWatch({ id: input.id });
  if (!watch || watch.conversationId === input.conversationId) {
    return watch;
  }
  const childAgents = await listDescendantAgents(input.conversationId);
  return childAgents.some(
    (childAgent) => childAgent.conversationId === watch.conversationId,
  )
    ? watch
    : undefined;
}
