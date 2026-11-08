/**
 * A person's Turn in a Thread. People message a Thread like a root, but it
 * stays a child: only a root delivers to its Location, so replies stay in
 * Junior. Agent invocation input and watch Events keep the child worker. A
 * person's Turn and an Agent invocation Turn are never open at the same time.
 */
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  getActiveConversationTurnId,
  listActiveMailboxTurns,
  parseWebMessages,
  type MailboxTurnWork,
} from "@/chat/task-execution/mailbox-turn";
import { supersedeOpenMailboxTurns } from "@/chat/task-execution/supersede-turns";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";

/**
 * Select the person's Turn work of a Thread, or undefined for Agent
 * invocation work. A Thread has one open Turn at a time, like a root. Web
 * Messages start a person's Turn, and an empty wake resumes the open person's
 * Turn. Every other input and wake goes to the child worker.
 */
export async function resolveThreadTurnWork(
  context: ConversationWorkerContext,
): Promise<MailboxTurnWork | undefined> {
  const batch = parseWebMessages(context.attempt.messages);
  if (batch.length > 0) {
    return { kind: "mailbox", batch };
  }
  if (context.attempt.messages.length > 0) {
    return undefined;
  }
  const turnId = await getActiveConversationTurnId(context.conversationId);
  return turnId ? { kind: "resume", turnId } : undefined;
}

/**
 * End a person's open Turn in a Thread before an agent invocation starts, as
 * new input does on a root. Only a Turn that waits for sign-in or lost its
 * worker can be open here: a yielded Turn resumes before new input.
 */
export async function supersedeOpenPersonTurn(
  conversationId: string,
): Promise<void> {
  if ((await listActiveMailboxTurns(conversationId)).length === 0) {
    return;
  }
  const conversation = coerceThreadConversationState(
    await getPersistedThreadState(conversationId),
  );
  await hydrateConversationMessages({ conversation, conversationId });
  await supersedeOpenMailboxTurns({ conversation, conversationId });
  await persistThreadStateById(conversationId, { conversation });
}
