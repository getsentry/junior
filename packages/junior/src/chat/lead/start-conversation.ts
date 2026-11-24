/**
 * Start one Conversation from a Lead. The new Conversation is a public web
 * root of the Lead's person and runs as that person, like any root. It has
 * no parent. Its person is a Participant, so it is on the Lead's team. The
 * Lead's brief is its first Message. The start is not reviewed. Action
 * review judges the new root's own tool calls, as it does a child agent's.
 */
import type { Actor } from "@/chat/actor";
import {
  appendAndEnqueueWebMessage,
  createConversationId,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import { readLeadUser } from "@/chat/lead/conversation";
import type { ConversationMessage } from "@/chat/state/conversation";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";

/**
 * Create the Conversation and enqueue the task as its first Message. Repeat
 * calls with the same `messageKey` are safe.
 */
export async function startLeadConversation(args: {
  leadConversationId: string;
  messageKey: string;
  queue: ConversationWorkQueue;
  task: string;
  title: string;
}): Promise<{ conversationId: string }> {
  const user = await readLeadUser(args.leadConversationId);
  if (!user) throw new Error("Only a Lead can start a Conversation");
  const idempotencyKey = `lead:${args.leadConversationId}:${args.messageKey}`;
  const conversationId = createConversationId({
    actorEmail: user.email,
    idempotencyKey,
  });
  await appendAndEnqueueWebMessage(
    {
      actor: webActorFromUser(user),
      conversationId,
      idempotencyKey,
      fromLead: true,
      message: args.task,
      rootTitle: args.title,
      rootVisibility: "public",
    },
    { nowMs: Date.now(), queue: args.queue },
  );
  return { conversationId };
}

/**
 * Return whether a Turn runs only the Lead's brief. A Turn that also takes
 * a Message from the person runs their words too.
 */
export function isLeadBrief(
  inputs: readonly Pick<ConversationMessage, "meta">[],
): boolean {
  return inputs.length === 1 && inputs[0]!.meta?.fromLead === true;
}

/**
 * Provenance of the brief: the person's instruction, so action review
 * counts it as their request, marked so that readers of the person's own
 * Messages skip it.
 */
export function leadBriefProvenance(
  actor: Actor,
): ConversationMessageProvenance {
  return { authority: "instruction", actor, fromLead: true };
}
