/**
 * Start one Conversation from a Space's Lead. The new Conversation is a web
 * root in the Lead's Space, with the Space's visibility. It runs as the
 * member who asked, like any root, and the Lead's task is its first Message.
 * The start is not reviewed. Action review judges the new root's own tool
 * calls, as it does a child agent's.
 */
import type { User } from "@sentry/junior-plugin-api";
import {
  appendAndEnqueueWebMessage,
  createConversationId,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import { readLeadSpace } from "@/chat/lead/conversation";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";

/**
 * Create the Conversation and enqueue the task as its first Message. Repeat
 * calls with the same `messageKey` are safe.
 */
export async function startLeadConversation(args: {
  leadConversationId: string;
  messageKey: string;
  /** The member whose request the task passes on. */
  person: Pick<User, "displayName" | "email" | "id">;
  queue: ConversationWorkQueue;
  task: string;
  title: string;
}): Promise<{ conversationId: string }> {
  const space = await readLeadSpace(args.leadConversationId);
  if (!space) throw new Error("Only a Space's Lead can start a Conversation");
  const idempotencyKey = `lead:${args.leadConversationId}:${args.messageKey}`;
  const conversationId = createConversationId({
    actorEmail: args.person.email,
    idempotencyKey,
  });
  await appendAndEnqueueWebMessage(
    {
      actor: webActorFromUser(args.person),
      conversationId,
      idempotencyKey,
      message: args.task,
      rootSpaceId: space.id,
      rootTitle: args.title,
      rootVisibility: space.visibility,
    },
    { nowMs: Date.now(), queue: args.queue },
  );
  return { conversationId };
}
