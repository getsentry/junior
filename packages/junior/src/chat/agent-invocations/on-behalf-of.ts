/**
 * Records and reads the Actor whose work a child agent does.
 *
 * A child agent never has a message from a person, and a watch, timer, or
 * result Turn of a child runs as the event system Actor. Action review still
 * reads the root Conversation for the person whose work it is. The runtime
 * records that Actor as `onBehalfOf` in the child's session log:
 *
 * - `spawnAgent` and `messageAgent` put it in the `meta` of the task message
 *   that they write into the child. It is the Actor of a root Turn, or the
 *   `onBehalfOf` of a child Turn. An Event Turn on a root is not from a
 *   person, so its task has none.
 * - Each child Turn uses the value of its own task message. Without one, it
 *   keeps the value of the child's latest instruction. The Turn saves the
 *   value in the provenance of its own instruction, so the next Turn keeps
 *   it.
 *
 * Only the runtime sets it. It never changes the Run Actor or credentials.
 */
import { actorSchema } from "@sentry/junior-plugin-api";
import type { Actor } from "@/chat/actor";
import type { AgentRun } from "@/chat/agent/types";
import { sameActorIdentity } from "@/chat/conversations/provenance";
import { getConversationEventStore } from "@/chat/db";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { getAgentInvocationMessageId } from "./store";
import type { AgentInvocation } from "./types";

/**
 * Return the Actor whose work a task from this Run serves. `actor` is the
 * Run Actor. Returns nothing for an Event Turn on a root.
 */
export function taskOnBehalfOf(
  run: Pick<AgentRun, "onBehalfOf" | "parentConversationId">,
  actor: Actor,
): Actor | undefined {
  if (run.parentConversationId) {
    return run.onBehalfOf;
  }
  return sameActorIdentity(actor, EVENT_SYSTEM_ACTOR) ? undefined : actor;
}

/** Read the `onBehalfOf` of one parent task from its task message. */
export async function readTaskOnBehalfOf(
  invocation: AgentInvocation,
): Promise<Actor | undefined> {
  if (!invocation.parentToolCallId) {
    return undefined;
  }
  const messageId = getAgentInvocationMessageId(invocation.invocationId);
  const event = await getConversationEventStore().loadByIdempotencyKey(
    invocation.childConversationId,
    `message:${messageId}`,
  );
  const value =
    event?.data.type === "message" ? event.data.meta?.onBehalfOf : undefined;
  return value === undefined ? undefined : actorSchema.parse(value);
}

/**
 * Return the Actor whose work the Turn of one agent invocation does: the
 * value of its own task, else the value of the child's latest instruction.
 */
export async function readAgentInvocationOnBehalfOf(
  invocation: AgentInvocation,
): Promise<Actor | undefined> {
  const task = await readTaskOnBehalfOf(invocation);
  if (task) {
    return task;
  }
  const latest = await getConversationEventStore().loadLatestInstruction(
    invocation.childConversationId,
  );
  return latest?.data.type === "user_message"
    ? latest.data.provenance.onBehalfOf
    : undefined;
}
