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
import { addConversationNote } from "@/chat/conversations/notes";
import {
  cancelWatch,
  getWatch,
  listWatches,
  type Watch,
} from "@/chat/events/store";

const MAX_NOTE_LABEL_CHARS = 120;

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

/**
 * Stop one watch that the Conversation owns. When the watch belongs to a child
 * agent below it, the child gets a Conversation note, so its next Turn knows
 * that the watch stopped. The note never starts a Turn. Returns the watch
 * after the stop, or undefined when it does not exist.
 */
export async function stopOwnedWatch(input: {
  conversationId: string;
  watch: Watch;
}): Promise<Watch | undefined> {
  const { watch } = input;
  const stopped = await cancelWatch({
    conversationId: watch.conversationId,
    id: watch.id,
  });
  if (
    watch.status === "active" &&
    stopped?.status === "cancelled" &&
    stopped.conversationId !== input.conversationId
  ) {
    const label =
      stopped.label.length > MAX_NOTE_LABEL_CHARS
        ? `${stopped.label.slice(0, MAX_NOTE_LABEL_CHARS - 1)}…`
        : stopped.label;
    await addConversationNote({
      conversationId: stopped.conversationId,
      createdAtMs: stopped.updatedAtMs,
      key: `watch_stopped:${stopped.id}`,
      text: `A parent agent above you stopped your watch ${stopped.id} (${label}). It will not wake you again.`,
    });
  }
  return stopped;
}
