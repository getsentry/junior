/**
 * A person's Turn in a Thread runs on the shared Conversation worker. A
 * person's Turn and an Agent invocation Turn are never open at the same time.
 */
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { listActiveMailboxTurns } from "@/chat/task-execution/mailbox-turn";
import { supersedeOpenMailboxTurns } from "@/chat/task-execution/supersede-turns";

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
