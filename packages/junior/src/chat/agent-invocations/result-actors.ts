import { mapBounded } from "@/chat/fan-out";
import type { Actor } from "@/chat/actor";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { actorSchema } from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { MailboxTurnWork } from "@/chat/task-execution/mailbox-turn";
import {
  childAgentInput,
  getChildAgentInputSender,
  routeChildInput,
} from "./child-input";
import {
  logDroppedParentMessage,
  parentMessageText,
  readParentMessage,
} from "./parent-message";
import { getLatestAgentInvocationForConversation } from "./store";

const senderActorMetadataSchema = z.object({ actor: actorSchema });

/**
 * Return the Inbound message author id for results sent by one Actor.
 * `selectContiguousTurnBatch` in `task-execution/worker.ts` puts messages in
 * one attempt only when their author ids and sources match. Mid-Turn drains
 * take only `interrupt` messages, and results are `defer`. So results never
 * share a Turn and its credentials with another Actor or with watch Events.
 * Keep this id unique per Actor if either rule changes.
 */
export function resultAuthorId(actor: Actor): string {
  switch (actor.platform) {
    case "system":
      return `agent-invocation:system:${actor.name}`;
    case "slack":
      return `agent-invocation:slack:${actor.teamId}:${actor.userId}`;
    default:
      return `agent-invocation:${actor.platform}:${actor.userId}`;
  }
}

/** Read the Actor that a reply or message from a child without an Agent invocation carries. */
function senderActorFromMetadata(metadata: unknown): Actor | undefined {
  const parsed = senderActorMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data.actor : undefined;
}

/**
 * Run each agent invocation result or message as the Actor that triggered the
 * child, user or system, with its grants. This is on purpose: the result
 * continues that Actor's work. The Actor comes from SQL when an agent
 * invocation names the child, so the parent Turn has the same authority it
 * had at spawn time. Otherwise the input carries it, and so does a parent
 * task to a child.
 * Input that a child's Turn with another Actor sent runs as the Event system
 * Actor, so it never gets more authority than that Turn. A result that a stop
 * skipped is dropped. Returns undefined when no input is left.
 */
export async function withAgentInvocationResultActors(
  work: MailboxTurnWork,
): Promise<MailboxTurnWork | undefined> {
  if (work.kind !== "mailbox") {
    return work;
  }
  const conversationId = work.batch[0]?.message.conversationId;
  const latest = conversationId
    ? await getLatestAgentInvocationForConversation(conversationId)
    : undefined;
  const batch = await mapBounded(work.batch, async (entry) => {
    // A parent message from the stored parent runs as the Actor of the
    // parent's Turn, with its grants and text, as on an Agent invocation.
    const parentMessage = readParentMessage(entry.message);
    if (parentMessage) {
      if ((await routeChildInput(entry.message, latest)) === "dropped") {
        logDroppedParentMessage(entry.message, parentMessage);
        return undefined;
      }
      const text = await parentMessageText(entry.message, parentMessage);
      return {
        ...entry,
        actor: parentMessage.actor,
        requestText: entry.message.input.text.trim(),
        ...(parentMessage.credentialContext
          ? { credentialContext: parentMessage.credentialContext }
          : undefined),
        message: {
          ...entry.message,
          input: { ...entry.message.input, text },
        },
      };
    }
    const input = childAgentInput(entry.message);
    if (!input) {
      return entry;
    }
    if ((await routeChildInput(entry.message, latest)) === "dropped") {
      return undefined;
    }
    const { invocation } = await getChildAgentInputSender(entry.message, input);
    // A child that no agent invocation names sends its Turn's Actor with
    // the input. The author id must match either Actor.
    const actor =
      invocation?.actor ??
      senderActorFromMetadata(entry.message.input.metadata);
    if (!actor || entry.message.input.authorId !== resultAuthorId(actor)) {
      return { ...entry, actor: EVENT_SYSTEM_ACTOR };
    }
    // Only a result continues the work of the Turn that spawned the child,
    // so only a result keeps that Turn's grants, such as a timer owner's. A
    // reply or message runs as the Actor only.
    return input.kind === "result" && invocation?.credentialContext
      ? {
          ...entry,
          actor,
          credentialContext: invocation.credentialContext,
        }
      : { ...entry, actor };
  });
  const kept = batch.filter((entry) => entry !== undefined);
  return kept.length > 0 ? { kind: "mailbox", batch: kept } : undefined;
}
