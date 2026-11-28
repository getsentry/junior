/**
 * The questions that agents ask in a Conversation (`junior_questions`).
 * They are Conversation data, so core makes every write here, and each write
 * moves the Conversation's detail version in its own transaction. The Inbox
 * reads them and reacts after the commit (`chat/questions/reactions.ts`).
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { touchConversationDetail } from "@/chat/conversations/sql/detail-version";
import type { JuniorDatabase } from "@/db/db";
import { juniorQuestions, juniorUsers } from "@/db/schema";
import type { InboxItemNoticeRequest, InboxItemRequest } from "./request";
import type { UserInputAnswer } from "./user-input-request";

/**
 * The stored content of a question. Only a notice that an older tool added
 * has no form: its request holds only related links.
 */
export interface QuestionContent {
  body: string;
  request: InboxItemRequest | InboxItemNoticeRequest | null;
  title: string;
}

/** One question with its answer and the person who gave it. */
export type Question = typeof juniorQuestions.$inferSelect & {
  answeredBy?: { displayName?: string; email: string; userId: string };
};

/**
 * Add one open question. Return false when it exists: a replay of the call
 * that asked it keeps the first write.
 */
export async function insertQuestion(
  db: JuniorDatabase,
  input: {
    content: QuestionContent;
    conversationId: string;
    id: string;
    nowMs: number;
    turnId?: string | undefined;
  },
): Promise<boolean> {
  const now = new Date(input.nowMs);
  return await db.transaction(async (tx) => {
    const asked = await tx
      .insert(juniorQuestions)
      .values({
        ...input.content,
        conversationId: input.conversationId,
        createdAt: now,
        id: input.id,
        turnId: input.turnId ?? null,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: juniorQuestions.id });
    if (!asked[0]) return false;
    await touchConversationDetail(tx, [input.conversationId]);
    return true;
  });
}

/**
 * Replace the content of one open question. Return false when it is closed
 * or gone. `turnId` moves its Turn to the Turn that asked it again.
 */
export async function updateQuestionContent(
  db: JuniorDatabase,
  input: {
    content: QuestionContent;
    id: string;
    nowMs: number;
    turnId?: string | undefined;
  },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const updated = await tx
      .update(juniorQuestions)
      .set({
        ...input.content,
        updatedAt: new Date(input.nowMs),
        ...(input.turnId ? { turnId: input.turnId } : undefined),
      })
      .where(
        and(eq(juniorQuestions.id, input.id), isNull(juniorQuestions.closedAt)),
      )
      .returning({ conversationId: juniorQuestions.conversationId });
    if (!updated[0]) return false;
    await touchConversationDetail(tx, [updated[0].conversationId]);
    return true;
  });
}

/**
 * Close questions: answered, done, or dismissed. An answer also records who
 * gave it and when. Run it once, in the transaction of the first close of
 * what shows the question, such as its Inbox item, so readers see both or
 * neither. It does not check that the question is open: a database trigger
 * for the release before this one may already have set its `closed_at`.
 */
export async function closeQuestions(
  db: JuniorDatabase,
  ids: readonly string[],
  input: { answer?: UserInputAnswer; answeredByUserId?: string; now: Date },
): Promise<void> {
  if (ids.length === 0) return;
  const closed = await db
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
    .where(inArray(juniorQuestions.id, [...ids]))
    .returning({ conversationId: juniorQuestions.conversationId });
  await touchConversationDetail(db, [
    ...new Set(closed.map((row) => row.conversationId)),
  ]);
}

/** Read one question with the person who answered it. */
export async function getQuestion(
  db: JuniorDatabase,
  id: string,
): Promise<Question | undefined> {
  const [row] = await db
    .select({
      question: juniorQuestions,
      answeredBy: {
        displayName: juniorUsers.displayName,
        email: juniorUsers.primaryEmail,
        userId: juniorUsers.id,
      },
    })
    .from(juniorQuestions)
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorQuestions.answeredByUserId))
    .where(eq(juniorQuestions.id, id))
    .limit(1);
  if (!row) return undefined;
  const by = row.answeredBy;
  return {
    ...row.question,
    ...(by
      ? {
          answeredBy: {
            email: by.email,
            userId: by.userId,
            ...(by.displayName ? { displayName: by.displayName } : undefined),
          },
        }
      : undefined),
  };
}
