/**
 * Start one Conversation from a Lead. The new Conversation is a public web
 * root of the Lead's person and runs as that person, like any root. The
 * Lead's task is its first Message. Action review judges the
 * `startConversation` call before this runs.
 */
import {
  appendAndEnqueueWebMessage,
  createConversationId,
  webActorFromUser,
} from "@/chat/conversations/web-input";
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
      rootTitle: args.title,
      rootVisibility: "public",
    },
    { nowMs: Date.now(), queue: args.queue },
  );
  return { conversationId };
}
