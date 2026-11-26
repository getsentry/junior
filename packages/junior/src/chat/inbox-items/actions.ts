import type { User } from "@sentry/junior-plugin-api";
import { getDb, getSqlExecutor } from "@/chat/db";
import { AutomationEditError } from "@/chat/automations/edit-rules";
import { ViewerTaskNotFoundError } from "@/chat/automations/read";
import { logWarn } from "@/chat/logging";
import { setTodoStatusByUser } from "@/chat/todos/store";
import {
  isEmptyUserInputAnswer,
  normalizeUserInputAnswer,
  type UserInputAnswer,
} from "@/chat/inbox-items/user-input-request";
import { deliverInboxItemChange, type InboxItemDelivery } from "./changes";
import type { InboxItemChange } from "./messages";
import {
  canActOnInboxItem,
  canAnswerInboxItem,
  canUserReadInboxItem,
  inboxItemTodo,
  isAutomationAlertItem,
  isInboxItemForEveryone,
  isOnlyAssignee,
  isPluginInboxItem,
} from "./access";
import { answerAutomationAlert } from "./automation-answer";
import { answerPluginInboxItem } from "./plugin-answer";
import { matchReplyToInboxItems } from "./reply-match";
import { closeHandledReplyNotices } from "./reply-notice";
import {
  closeInboxItem,
  getInboxItem,
  listReplyActionItems,
  INBOX_ITEM_REPLIED_REASON,
  ownerConversationId,
  takeInboxItem,
  type InboxItem,
} from "./store";

/**
 * What a person can do with an Inbox item. A To-do's item takes only
 * `done` and `dismiss`, and only a To-do's item takes `done`.
 */
export type InboxItemAction = "take" | "submit" | "dismiss" | "done";

/** An expected failure of a person action, for the API to report. */
export class InboxItemActionError extends Error {
  readonly code: "conflict" | "forbidden" | "invalid" | "not_found";

  constructor(code: InboxItemActionError["code"], message: string) {
    super(message);
    this.name = "InboxItemActionError";
    this.code = code;
  }
}

/** Read one Inbox item that a User can see, or fail as not found. */
export async function readInboxItemForUser(
  user: User,
  id: string,
): Promise<InboxItem> {
  const item = await getInboxItem(getDb(), id);
  if (!item || !(await canUserReadInboxItem(item, user))) {
    throw new InboxItemActionError("not_found", "Inbox item not found.");
  }
  return item;
}

function closedStatus(action: Exclude<InboxItemAction, "take">) {
  return action === "dismiss" ? "dismissed" : "done";
}

/** The change that one person action makes, for messages and notes. */
export function reviewItemChange(
  action: InboxItemAction,
  user: User,
): InboxItemChange {
  if (action === "take") return { kind: "taken", user };
  if (action === "submit" || action === "done") {
    return { kind: "submitted", user };
  }
  return { kind: "dismissed", user };
}

/**
 * Return whether a closed item is the result of this same action. An item
 * that a person's message closed never matches a card or Inbox action.
 */
function isSameClose(
  item: InboxItem,
  action: Exclude<InboxItemAction, "take" | "done">,
  user: User,
): boolean {
  return (
    item.closeReason !== INBOX_ITEM_REPLIED_REASON &&
    item.closedBy?.userId === user.id &&
    item.status === closedStatus(action) &&
    (action === "submit") === Boolean(item.answer)
  );
}

function submittedAnswer(
  item: InboxItem,
  answer: UserInputAnswer | undefined,
): UserInputAnswer {
  if (item.kind !== "action" || !item.request) {
    throw new InboxItemActionError(
      "invalid",
      "Only an action item takes an answer.",
    );
  }
  const normalized = normalizeUserInputAnswer(item.request, {
    other: answer?.other,
    requestId: item.id,
    values: answer?.values ?? {},
  });
  if (isEmptyUserInputAnswer(normalized)) {
    throw new InboxItemActionError("invalid", "The answer is empty.");
  }
  return normalized;
}

/**
 * Do one person action on an Inbox item and tell its linked Conversations.
 * Only the Conversation that added the item gets an answer as input; see
 * `sendInboxItemMessages`. The first submit or dismiss closes the item for every
 * assignee. A retry of the same close sends any missing messages again and
 * succeeds, so a client can retry after a failure. With `firstCloseOnly`,
 * only the call that closes the item succeeds, and every other call gets a
 * conflict. Use it when the caller adds its own input for the action, such
 * as a card click in a chat thread, so one action adds one Turn.
 * `exceptConversationId` is the Conversation where the person acted. It gets
 * the person's input from its own surface, so it gets no message here.
 * `delivery` shows the change and sends the messages; see
 * `deliverInboxItemChange`. A submit, dismiss, or done also closes the
 * person's reply notices in the item's Conversations: the item had their
 * attention.
 */
export async function actOnInboxItem(args: {
  action: InboxItemAction;
  answer?: UserInputAnswer;
  delivery: InboxItemDelivery;
  exceptConversationId?: string;
  firstCloseOnly?: boolean;
  id: string;
  nowMs?: number;
  user: User;
}): Promise<InboxItem> {
  const { action, user } = args;
  const nowMs = args.nowMs ?? Date.now();
  const db = getDb();
  const item = await readInboxItemForUser(user, args.id);
  const todo = inboxItemTodo(item);
  if (todo) {
    if (action !== "done" && action !== "dismiss") {
      throw new InboxItemActionError(
        "invalid",
        "A To-do item takes only Done or Dismiss.",
      );
    }
    const closed = await closeTodoItem(item, user, nowMs, action);
    await closeHandledReplyNotices(db, {
      item: closed,
      nowMs,
      userId: user.id,
    });
    return closed;
  }
  if (action === "done") {
    throw new InboxItemActionError(
      "invalid",
      "Only a To-do item can be marked done.",
    );
  }

  if (action === "take") {
    if (item.status !== "open") {
      throw new InboxItemActionError("conflict", "Inbox item is closed.");
    }
    if (!canActOnInboxItem(item, user.id)) {
      throw new InboxItemActionError(
        "forbidden",
        "Only an assignee can take this item.",
      );
    }
    // A retry after a failed send finds the User already the only assignee.
    // It still sends: each take message has a key, so only missing ones go.
    if (
      !isOnlyAssignee(item, user.id) &&
      !(await takeInboxItem(db, { id: item.id, nowMs, userId: user.id }))
    ) {
      throw new InboxItemActionError("conflict", "Inbox item is closed.");
    }
    const taken = await readInboxItemForUser(user, item.id);
    await deliverInboxItemChange({
      change: reviewItemChange(action, user),
      delivery: args.delivery,
      exceptConversationId: args.exceptConversationId,
      item: taken,
      nowMs,
    });
    return taken;
  }

  let closed = item;
  let closedNow = false;
  if (item.status === "open") {
    // Anyone who can see a public question can answer it. Dismiss keeps the
    // assignee rule (`canAnswerInboxItem`).
    const allowed =
      action === "submit"
        ? canAnswerInboxItem(item, user.id)
        : canActOnInboxItem(item, user.id);
    if (!allowed) {
      throw new InboxItemActionError(
        "forbidden",
        "Only an assignee can act on this item.",
      );
    }
    const answer =
      action === "submit" ? submittedAnswer(item, args.answer) : undefined;
    closedNow = await closeInboxItem(db, {
      closedByUserId: user.id,
      id: item.id,
      nowMs,
      status: closedStatus(action),
      ...(answer ? { answer } : undefined),
    });
    closed = await readInboxItemForUser(user, item.id);
  }
  if (args.firstCloseOnly ? !closedNow : !isSameClose(closed, action, user)) {
    throw new InboxItemActionError("conflict", "Inbox item is closed.");
  }
  await closeHandledReplyNotices(db, { item: closed, nowMs, userId: user.id });
  // The plugin that added the item does the work, so its answer starts no
  // Turn. A retry of the same answer calls the plugin again.
  if (action === "submit" && isPluginInboxItem(closed)) {
    await answerPluginInboxItem({
      delivery: args.delivery,
      item: closed,
      nowMs,
    });
  }
  // Core takes the step that a person picked on an Automation alert. A
  // retry of the same answer takes it again.
  if (action === "submit" && isAutomationAlertItem(closed)) {
    try {
      await answerAutomationAlert({ item: closed, user });
    } catch (error) {
      if (error instanceof ViewerTaskNotFoundError) {
        throw new InboxItemActionError("not_found", "Automation not found.");
      }
      if (error instanceof AutomationEditError) {
        throw new InboxItemActionError("invalid", error.message);
      }
      throw error;
    }
  }
  await deliverInboxItemChange({
    change: reviewItemChange(action, user),
    delivery: args.delivery,
    exceptConversationId: args.exceptConversationId,
    item: closed,
    nowMs,
  });
  return closed;
}

/**
 * Close a To-do item for its assignee through its To-do: Done marks the
 * To-do done, and Dismiss drops it. The To-do change closes the item as
 * done or dismissed (`syncTodoInboxItems`), and the agent sees it in its
 * next To-do delta, so it sends no message and starts no Turn. A retry
 * after the item closed the same way by the same person succeeds.
 */
async function closeTodoItem(
  item: InboxItem,
  user: User,
  nowMs: number,
  action: "dismiss" | "done",
): Promise<InboxItem> {
  const todo = inboxItemTodo(item)!;
  if (item.status === "open") {
    if (!canActOnInboxItem(item, user.id)) {
      throw new InboxItemActionError(
        "forbidden",
        "Only an assignee can act on this item.",
      );
    }
    await setTodoStatusByUser(getSqlExecutor(), {
      assignedOnly: true,
      conversationId: todo.conversationId,
      id: todo.id,
      nowMs,
      status: action === "done" ? "done" : "dropped",
      userId: user.id,
    });
  }
  const closed = await readInboxItemForUser(user, item.id);
  if (
    closed.status !== closedStatus(action) ||
    closed.closedBy?.userId !== user.id
  ) {
    throw new InboxItemActionError("conflict", "Inbox item is closed.");
  }
  return closed;
}

/**
 * Return whether a reply from this User answers an open action item, or is
 * a retry of the reply from this User that closed it.
 */
function replyAnswers(item: InboxItem, user: User | undefined): boolean {
  if (item.status !== "open") return item.closedBy?.userId === user?.id;
  if (isInboxItemForEveryone(item)) return false;
  return (
    user !== undefined &&
    item.assignees.some((assignee) => assignee.userId === user.id)
  );
}

/** Return the answer that the text of a person's message gives to an item. */
function messageAnswer(
  item: InboxItem,
  text: string,
): UserInputAnswer | undefined {
  if (!item.request) return undefined;
  const answer = normalizeUserInputAnswer(item.request, {
    other: text,
    requestId: item.id,
    values: {},
  });
  return isEmptyUserInputAnswer(answer) ? undefined : answer;
}

/**
 * Close the open action items that a person answered with a reply in their
 * thread. Call it after the reply is saved to the Conversation, so the
 * reply always reaches the agent. Each item that it closes saves `text` as
 * its answer, so the item keeps what the person said.
 *
 * A reply closes an item only when all of these are true:
 * - The item is an open `action` item.
 * - The agent added it in this Conversation, its owner, or this is a root
 *   and one of its child agents added it.
 * - The replier is an assigned User. A Slack replier without a Junior User
 *   closes no item.
 * - The decision model says that the reply answers this item
 *   (`matchReplyToInboxItems`). Other open items in the thread stay open.
 *   When the decision fails, all items stay open.
 *
 * Items for Everyone (`isInboxItemForEveryone`, also an item with no
 * assignees), or only for other people, stay open. They need an answer on
 * the card or the Inbox. Each item closes as `done` with
 * `INBOX_ITEM_REPLIED_REASON`, and the replier closes it. The reply itself
 * is the answer in this Conversation. When a child agent owns the item, it
 * gets the reply as the person's answer. The other linked Conversations only
 * record the close. A click that closes the item first wins.
 * A retry of the reply, or a later reply from the same person, delivers
 * the items that it closed again: the cards show the close, and only the
 * missing messages go. Each message has a key, so a message that was sent
 * does not go again. `delivery` shows the change and sends the messages;
 * see `deliverInboxItemChange`.
 */
export async function closeInboxItemsAnsweredByReply(args: {
  /**
   * Return false when the replier may not answer, such as a Slack author
   * outside the allowed domains. It runs only when an item can match.
   */
  canAnswer?: () => Promise<boolean>;
  conversationId: string;
  delivery: InboxItemDelivery;
  nowMs?: number;
  resolveUser: () => Promise<User | undefined>;
  text: string;
}): Promise<void> {
  const db = getDb();
  const items = await listReplyActionItems(db, args.conversationId);
  if (items.length === 0) return;
  if (args.canAnswer && !(await args.canAnswer())) return;
  const user = await args.resolveUser();
  const nowMs = args.nowMs ?? Date.now();
  // A child agent's item takes the reply as that person's input, so it
  // needs a User to run as.
  const answered = items.filter(
    (candidate) =>
      replyAnswers(candidate, user) &&
      (user !== undefined ||
        ownerConversationId(candidate) === args.conversationId),
  );
  let matched: Set<string>;
  try {
    matched = await matchReplyToInboxItems({
      conversationId: args.conversationId,
      items: answered.filter((candidate) => candidate.status === "open"),
      text: args.text,
    });
  } catch (error) {
    // The reply is already saved, so the agent still gets it.
    logWarn("inbox_item.reply_match.failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
      "gen_ai.conversation.id": args.conversationId,
    });
    matched = new Set();
  }
  // A retry of a reply still delivers the items that it closed.
  const toDeliver = answered.filter(
    (candidate) => candidate.status !== "open" || matched.has(candidate.id),
  );
  /* oxlint-disable no-await-in-loop -- Close and deliver answered items in order, one at a time. */
  for (const item of toDeliver) {
    let closedItem: InboxItem | undefined = item;
    if (item.status === "open") {
      const answer = messageAnswer(item, args.text);
      const closed = await closeInboxItem(db, {
        ...(answer ? { answer } : undefined),
        id: item.id,
        nowMs,
        reason: INBOX_ITEM_REPLIED_REASON,
        status: "done",
        ...(user ? { closedByUserId: user.id } : undefined),
      });
      if (!closed) continue;
      closedItem = await getInboxItem(db, item.id);
      if (!closedItem) continue;
    }
    // The reply is the answer in this Conversation. The child agent that
    // asked gets it as the person's answer, like a click on its card.
    await deliverInboxItemChange({
      change:
        user && ownerConversationId(closedItem) !== args.conversationId
          ? { kind: "submitted", user }
          : {
              kind: "replied",
              who: user ? (user.displayName ?? user.email) : "A person",
            },
      delivery: args.delivery,
      exceptConversationId: args.conversationId,
      item: closedItem,
      nowMs,
    });
  }
  /* oxlint-enable no-await-in-loop */
}
