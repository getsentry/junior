import type { JuniorDatabase } from "@/db/db";
import { closeQuestions } from "@/chat/questions/store";
import type { UserInputAnswer } from "@/chat/questions/user-input-request";
import { INBOX_SUBJECT_KINDS } from "./subjects";

/**
 * Close the questions of Inbox items that just closed, in the transaction
 * that closed them, so readers see both or neither. Core's question store
 * makes the write.
 */
export async function closeItemQuestions(
  tx: JuniorDatabase,
  items: readonly { subjectId: string; subjectKind: string }[],
  input: { answer?: UserInputAnswer; answeredByUserId?: string; now: Date },
): Promise<void> {
  await closeQuestions(
    tx,
    items.flatMap((item) =>
      item.subjectKind === INBOX_SUBJECT_KINDS.question ? [item.subjectId] : [],
    ),
    input,
  );
}
