import { isDeepStrictEqual } from "node:util";
import type { CredentialSubject } from "@/chat/credentials/context";
import { verifyTimerWatchCredentialSubject } from "@/chat/credentials/subject";
import { readConversationLineage } from "@/chat/conversations/lineage";
import type { MailboxTurnInput } from "@/chat/task-execution/mailbox-turn";

/**
 * Return a saved timer creator subject when it is still valid here. The
 * timer's Watch belongs to this Conversation. It may also belong to an
 * ancestor when `fromParent`: the input is a parent message that passed its
 * sender check, so the child continues the work of the parent's timer Turn.
 */
export async function verifiedTimerWatchSubject(
  conversationId: string,
  subject: CredentialSubject | undefined,
  fromParent: boolean,
): Promise<CredentialSubject | undefined> {
  if (subject?.binding.type !== "timer-watch") return undefined;
  const watchConversationId = subject.binding.conversationId;
  if (
    watchConversationId !== conversationId &&
    !(
      fromParent &&
      (await readConversationLineage(conversationId)).some(
        (entry) => entry.conversationId === watchConversationId,
      )
    )
  ) {
    return undefined;
  }
  return verifyTimerWatchCredentialSubject({
    conversationId: watchConversationId,
    subject,
    watchId: subject.binding.watchId,
  })
    ? subject
    : undefined;
}

/** Return the delegated subject that every input of a batch carries, if any. */
export function sharedDelegatedSubject(
  batch: readonly MailboxTurnInput[],
): CredentialSubject | undefined {
  const subjects = batch.map((entry) =>
    entry.credentialContext && "subject" in entry.credentialContext
      ? entry.credentialContext.subject
      : undefined,
  );
  const first = subjects[0];
  return first && subjects.every((subject) => isDeepStrictEqual(subject, first))
    ? first
    : undefined;
}
