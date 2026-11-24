/**
 * Start one Conversation from a Lead. The new Conversation is a public web
 * root of the Lead's person and runs as that person, like any root. It
 * stores the Lead as its team, not as a parent: it has no parent. The Lead's
 * brief is its first Message. The start is not reviewed. Action review
 * judges the new root's own tool calls, as it does a child agent's.
 */
import type { Actor } from "@/chat/actor";
import {
  appendAndEnqueueWebMessage,
  createConversationId,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import type { Conversation } from "@/chat/conversations/store";
import { getConversationEventStore } from "@/chat/db";
import { readLeadUser } from "@/chat/lead/conversation";
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
      message: args.task,
      rootLeadConversationId: args.leadConversationId,
      rootTitle: args.title,
      rootVisibility: "public",
    },
    { nowMs: Date.now(), queue: args.queue },
  );
  return { conversationId };
}

/**
 * Return whether a Turn runs the Lead's brief: the one web input of a root
 * that a Lead started, when no other Message came before it. A new and a
 * resumed Turn read the same stored facts. The Message log is never trimmed,
 * unlike the loaded Message window.
 */
export async function isLeadBriefTurn(args: {
  actor: Actor;
  conversation: Pick<
    Conversation,
    "conversationId" | "leadConversationId" | "transcriptPurgedAtMs"
  >;
  inputMessageIds: readonly string[];
}): Promise<boolean> {
  const { conversation, inputMessageIds } = args;
  if (
    conversation.leadConversationId === undefined ||
    conversation.transcriptPurgedAtMs !== undefined ||
    args.actor.platform !== "web" ||
    inputMessageIds.length !== 1
  ) {
    return false;
  }
  const [opening] = (
    await getConversationEventStore().query(conversation.conversationId, {
      afterSeq: -1,
      limit: 1,
      types: ["message"],
    })
  ).events;
  return (
    !opening ||
    (opening.data.type === "message" &&
      opening.data.messageId === inputMessageIds[0])
  );
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
