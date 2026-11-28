import { getDb } from "@/chat/db";
import { getInboxItem, insertInboxItem } from "@/chat/inbox-items/store";
import { itemResult } from "@/chat/inbox-items/tool-support";
import { INBOX_SUBJECT_KINDS } from "@/chat/inbox-items/subjects";
import { insertQuestion } from "@/chat/questions/store";
import type { JuniorDatabase } from "@/db/db";

/**
 * `askUserQuestion` input for one question with two choices, Yes and No,
 * that asks `text`. Its stored item has `text` as its title and body.
 */
export function ask(text: string, header = "Decision") {
  return [
    {
      question: text,
      header,
      options: [
        { label: "Yes", description: "Go ahead." },
        { label: "No", description: "Stop here." },
      ],
    },
  ];
}

/**
 * Insert an Inbox item the way the app adds it. Core stores a question
 * before the Inbox adds its item, so a question item gets its question
 * first. Other items go to `insertInboxItem` as given.
 */
export async function insertTestInboxItem(
  db: JuniorDatabase,
  input: Parameters<typeof insertInboxItem>[1],
): ReturnType<typeof insertInboxItem> {
  if (input.subject.kind === INBOX_SUBJECT_KINDS.question) {
    await insertQuestion(db, {
      content: {
        body: input.body,
        request: input.request ?? null,
        title: input.title,
      },
      conversationId: input.owner.id,
      id: input.subject.id,
      nowMs: input.nowMs,
      turnId: input.addedByTurnId,
    });
  }
  return await insertInboxItem(db, input);
}

/**
 * The Inbox item of a question that `askUserQuestion` asked, in the shape
 * that the Inbox tools return. The Inbox adds it after the ask commits, with
 * the question's id.
 */
export async function askedItem(result: { question: { id: string } }) {
  const item = await getInboxItem(getDb(), result.question.id);
  if (!item) throw new Error(`Question ${result.question.id} has no item`);
  return itemResult(item);
}
