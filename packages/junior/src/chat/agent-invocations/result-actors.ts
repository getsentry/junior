import { mapBounded } from "@/chat/fan-out";
import type { Actor } from "@/chat/actor";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { actorSchema } from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { MailboxTurnWork } from "@/chat/task-execution/mailbox-turn";
import {
  childAgentInput,
  getChildAgentInputSender,
  isDroppedChildInput,
} from "./child-input";
import { logDroppedParentMessage, parentMessageText } from "./parent-message";
import { readParentMessage } from "./parent-message-input";

const senderActorMetadataSchema = z.object({ actor: actorSchema });

/**
 * Return the Inbound message author id for results sent by one Actor.
 * `selectContiguousTurnBatch` in `task-execution/worker.ts` puts messages in
 * one attempt only when their author ids and sources match. Mid-Turn drains
 * take only `interrupt` messages, parent messages, and a Lead's messages,
 * and results are `defer` Events. So results never share a Turn and its
 * credentials with another Actor or with watch Events.
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

/** Read the Actor of the child Turn that a reply or message carries. */
function senderActorFromMetadata(metadata: unknown): Actor | undefined {
  const parsed = senderActorMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data.actor : undefined;
}

/**
 * Run each child reply or message as the Actor of the child Turn that sent
 * it, which the input carries, so the parent never gets more authority than
 * that Turn. A parent message from the stored parent runs as the Actor of the
 * parent's Turn, with its grants and text. Input that a Turn with another
 * Actor sent, or that names no child of this Conversation, runs as the Event
 * system Actor. Input that `isDroppedChildInput` drops is left out. Returns
 * undefined when no input is left.
 */
export async function withAgentInvocationResultActors(
  work: MailboxTurnWork,
): Promise<MailboxTurnWork | undefined> {
  if (work.kind !== "mailbox") {
    return work;
  }
  const batch = await mapBounded(work.batch, async (entry) => {
    const parentMessage = readParentMessage(entry.message);
    if (parentMessage) {
      if (await isDroppedChildInput(entry.message)) {
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
    if (await isDroppedChildInput(entry.message)) {
      return undefined;
    }
    const sender = await getChildAgentInputSender(entry.message, input);
    const actor = senderActorFromMetadata(entry.message.input.metadata);
    if (
      !sender ||
      !actor ||
      entry.message.input.authorId !== resultAuthorId(actor)
    ) {
      return { ...entry, actor: EVENT_SYSTEM_ACTOR };
    }
    return { ...entry, actor };
  });
  const kept = batch.filter((entry) => entry !== undefined);
  return kept.length > 0 ? { kind: "mailbox", batch: kept } : undefined;
}
