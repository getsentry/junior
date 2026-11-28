/**
 * How the Inbox follows a Conversation's own data after core commits it:
 * a question gets its item, a person's message answers the open questions
 * that it matches, and To-dos sync their items. Core reports each change
 * through `reactToConversationChange` and never calls the Inbox itself.
 */
import type { ConversationChange } from "@/chat/conversations/change-reactions";
import { getDb } from "@/chat/db";
import { closeInboxItemsAnsweredByReply } from "@/chat/inbox-items/actions";
import {
  deliverInboxItemChange,
  type InboxItemDelivery,
} from "@/chat/inbox-items/changes";
import { questionSubject } from "@/chat/inbox-items/access";
import { closeReadReplyNotice } from "@/chat/inbox-items/reply-notice";
import {
  getOpenInboxItemBySubject,
  insertInboxItem,
} from "@/chat/inbox-items/store";
import { syncTodoInboxItems } from "@/chat/inbox-items/todo-items";
import { pushConversationInboxItemsNow } from "@/chat/notifications/inbox-item-push";
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

async function answerByMessage(change: Change<"person_message">) {
  await closeInboxItemsAnsweredByReply({
    ...(change.canAnswer ? { canAnswer: change.canAnswer } : undefined),
    conversationId: change.conversationId,
    delivery: delivery(change.services),
    resolveUser: change.resolveUser,
    text: change.text,
  });
  if (!change.viewed) return;
  // The person saw the transcript so far, so the reply notice closes.
  const user = await change.resolveUser();
  if (!user) return;
  await closeReadReplyNotice(getDb(), {
    conversationId: change.conversationId,
    nowMs: Date.now(),
    userId: user.id,
  });
}

/** The Inbox's reaction to one committed Conversation change. */
export async function reactInboxToConversationChange(
  change: ConversationChange,
): Promise<void> {
  switch (change.kind) {
    case "question_asked":
      return await addQuestionItem(change);
    case "person_message":
      return await answerByMessage(change);
    case "delivery_resumed":
      return await pushConversationInboxItemsNow(change.conversationId);
    case "todos_changed":
      return await syncTodoInboxItems(getDb(), change);
  }
}
