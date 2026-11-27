import { inArray } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorQuestions } from "@/db/schema";
import type { UserInputAnswer } from "./user-input-request";
import { INBOX_SUBJECT_KINDS } from "./subjects";

/**
 * Close the questions of Inbox items that just closed, in the transaction
 * that closed them. A question holds its own `closed_at`, so Conversation
 * reads see that it no longer waits without reading the Inbox. An answer
 * also records who gave it and when.
 */
export async function closeItemQuestions(
  tx: JuniorDatabase,
  items: readonly { subjectId: string; subjectKind: string }[],
  input: { answer?: UserInputAnswer; answeredByUserId?: string; now: Date },
): Promise<void> {
  const ids = items.flatMap((item) =>
    item.subjectKind === INBOX_SUBJECT_KINDS.question ? [item.subjectId] : [],
  );
  if (ids.length === 0) return;
  await tx
    .update(juniorQuestions)
    .set({
      ...(input.answer
        ? {
            answer: input.answer,
            answeredAt: input.now,
            answeredByUserId: input.answeredByUserId ?? null,
          }
        : undefined),
      closedAt: input.now,
      updatedAt: input.now,
    })
    .where(inArray(juniorQuestions.id, ids));
}
