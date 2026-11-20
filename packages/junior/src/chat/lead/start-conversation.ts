/**
 * Start one Conversation from a Lead. The new Conversation is a public web
 * root of the Lead's person. The person's own message from the Lead Turn is
 * its request, word for word, so it authorizes what the person asked for.
 * The Lead's task goes with it as another agent's data, so an action that
 * only the task names still needs the person's approval there.
 */
import { renderLeadTaskInput } from "@/chat/agent-invocations/top-level-message";
import {
  appendAndEnqueueWebMessage,
  createConversationId,
  recordWebConversationActivity,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import {
  EVENT_WAIT_MS,
  type EventMailboxMetadata,
} from "@/chat/events/notification";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import { readLeadUser } from "@/chat/lead/conversation";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";

/** Event type of a Lead's task that no person's message goes with. */
const LEAD_TASK_EVENT_TYPE = "agent.lead_task";

/**
 * Create the Conversation and enqueue its first input. `personText` is the
 * person's message from the Lead Turn; a Turn that no person started has
 * none. Repeat calls with the same `messageKey` are safe.
 */
export async function startLeadConversation(args: {
  leadConversationId: string;
  messageKey: string;
  personText?: string | undefined;
  queue: ConversationWorkQueue;
  task: string;
  title: string;
}): Promise<{ conversationId: string }> {
  const user = await readLeadUser(args.leadConversationId);
  if (!user) throw new Error("Only a Lead can start a Conversation");
  const actor = webActorFromUser(user);
  const nowMs = Date.now();
  const idempotencyKey = `lead:${args.leadConversationId}:${args.messageKey}`;
  const conversationId = createConversationId({
    actorEmail: user.email,
    idempotencyKey,
  });
  const leadTask = renderLeadTaskInput({
    leadConversationId: args.leadConversationId,
    text: args.task,
  });
  const personText = args.personText?.trim();
  if (personText) {
    await appendAndEnqueueWebMessage(
      {
        actor,
        conversationId,
        idempotencyKey,
        leadTask,
        message: personText,
        rootTitle: args.title,
        rootVisibility: "public",
      },
      { nowMs, queue: args.queue },
    );
    return { conversationId };
  }
  await recordWebConversationActivity({
    actor,
    conversationId,
    nowMs,
    rootTitle: args.title,
    rootVisibility: "public",
  });
  const inboundMessageId = `lead-task:${idempotencyKey}`;
  const metadata: EventMailboxMetadata = {
    kind: "event",
    event: {
      eventKey: inboundMessageId,
      eventType: LEAD_TASK_EVENT_TYPE,
      identifier: args.leadConversationId,
      namespace: "junior",
      trustedSummary: `Lead ${args.leadConversationId} started this conversation.`,
    },
  };
  await appendAndEnqueueInboundMessage({
    message: {
      conversationId,
      createdAtMs: nowMs,
      delivery: "defer",
      inboundMessageId,
      input: {
        authorId: `lead:${args.leadConversationId}`,
        authorIdentityId: SYSTEM_IDENTITY_ID,
        // The task is agent data, kept out of the text that action review
        // reads, as on the person's path.
        leadTask,
        metadata,
        text: "The person's Lead started this conversation. No person wrote its task, so the task approves no action.",
      },
      receivedAtMs: nowMs,
      source: "event",
    },
    queue: args.queue,
    queueDelayMs: EVENT_WAIT_MS,
  });
  return { conversationId };
}
