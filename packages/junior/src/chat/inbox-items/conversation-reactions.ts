/**
 * How the Inbox follows a Conversation's own data after core commits it:
 * a question gets its item. Core reports each change through
 * `reactToConversationChange` and never calls the Inbox itself.
 */
import type { ConversationChange } from "@/chat/conversations/change-reactions";
import { getDb } from "@/chat/db";
import {
  deliverInboxItemChange,
  type InboxItemDelivery,
} from "@/chat/inbox-items/changes";
import { questionSubject } from "@/chat/inbox-items/access";
import {
  getOpenInboxItemBySubject,
  insertInboxItem,
} from "@/chat/inbox-items/store";
import { createInboxItemShow } from "@/chat/notifications/inbox-item-show";
import { getQuestion } from "@/chat/questions/store";

type Change<K extends ConversationChange["kind"]> = Extract<
  ConversationChange,
  { kind: K }
>;

function delivery(
  services: Change<"question_asked">["services"],
): InboxItemDelivery {
  return {
    queue: services.queue(),
    show: createInboxItemShow(services.slackAdapter),
  };
}

// The item has the question's id, so an answer to the item names the
// question. A replay of the ask finds the item that it added before.
async function addQuestionItem(change: Change<"question_asked">) {
  const db = getDb();
  const question = await getQuestion(db, change.questionId);
  if (!question) {
    throw new Error(`Question ${change.questionId} is not found`);
  }
  const subject = questionSubject(question.id);
  const item =
    (await insertInboxItem(db, {
      assignedToEveryone: change.asked.everyone,
      assigneeUserIds: change.asked.userIds,
      body: question.body,
      conversationIds: [question.conversationId],
      kind: "action",
      owner: { id: question.conversationId, kind: "conversation" },
      ...(question.request ? { request: question.request } : undefined),
      subject,
      title: question.title,
      ...(question.turnId ? { addedByTurnId: question.turnId } : undefined),
      nowMs: Date.now(),
    })) ?? (await getOpenInboxItemBySubject(db, subject));
  // A question that closed before the replay has nothing left to show.
  if (!item) return;
  await deliverInboxItemChange({
    delivery: delivery(change.services),
    item,
    nowMs: Date.now(),
  });
}

/** The Inbox's reaction to one committed Conversation change. */
export async function reactInboxToConversationChange(
  change: ConversationChange,
): Promise<void> {
  switch (change.kind) {
    case "question_asked":
      return await addQuestionItem(change);
  }
}
