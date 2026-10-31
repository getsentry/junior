import type { SlackAdapter } from "@chat-adapter/slack";
import type { User } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { syncReviewItemSlackCards } from "@/chat/slack/review-item-card-sync";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  isEmptyUserInputAnswer,
  normalizeUserInputAnswer,
  type UserInputAnswer,
} from "@/chat/tools/runtime/user-input-request";
import { sendReviewItemMessages, type ReviewItemChange } from "./messages";
import {
  canActOnReviewItem,
  canReadReviewItem,
  isOnlyAssignee,
  reviewItemReaderForUser,
} from "./access";
import {
  closeReviewItem,
  getReviewItem,
  listReplyActionItems,
  REVIEW_ITEM_REPLIED_REASON,
  takeReviewItem,
  type ReviewItem,
} from "./store";

/** What a person can do with a Review item. */
export type ReviewItemAction = "take" | "submit" | "complete" | "dismiss";

/** An expected failure of a person action, for the API to report. */
export class ReviewItemActionError extends Error {
  readonly code: "conflict" | "forbidden" | "invalid" | "not_found";

  constructor(code: ReviewItemActionError["code"], message: string) {
    super(message);
    this.name = "ReviewItemActionError";
    this.code = code;
  }
}

/** Read one Review item that a User can see, or fail as not found. */
export async function readReviewItemForUser(
  user: User,
  id: string,
): Promise<ReviewItem> {
  const item = await getReviewItem(getDb(), id);
  if (!item || !canReadReviewItem(item, reviewItemReaderForUser(user))) {
    throw new ReviewItemActionError("not_found", "Review item not found.");
  }
  return item;
}

function closedStatus(action: Exclude<ReviewItemAction, "take">) {
  return action === "dismiss" ? "dismissed" : "done";
}

/** The change that one person action makes, for messages and notes. */
export function reviewItemChange(
  action: ReviewItemAction,
  user: User,
): ReviewItemChange {
  if (action === "take") return { kind: "taken", user };
  if (action === "submit") return { kind: "submitted", user };
  if (action === "complete") return { kind: "completed", user };
  return { kind: "dismissed", user };
}

/**
 * Return whether a closed item is the result of this same action. A close by
 * a reply in the thread is never the same as an action on the card.
 */
function isSameClose(
  item: ReviewItem,
  action: Exclude<ReviewItemAction, "take">,
  user: User,
): boolean {
  return (
    item.closeReason !== REVIEW_ITEM_REPLIED_REASON &&
    item.closedBy?.userId === user.id &&
    item.status === closedStatus(action) &&
    (action === "submit") === Boolean(item.answer)
  );
}

function submittedAnswer(
  item: ReviewItem,
  answer: UserInputAnswer | undefined,
): UserInputAnswer {
  if (item.kind !== "action" || !item.request) {
    throw new ReviewItemActionError(
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
    throw new ReviewItemActionError("invalid", "The answer is empty.");
  }
  return normalized;
}

/**
 * Do one person action on a Review item and tell its linked Conversations.
 * The first submit, complete, or dismiss closes the item for every
 * assignee. A retry of the same close sends any missing messages again and
 * succeeds, so a client can retry after a failure. With `firstCloseOnly`,
 * only the call that closes the item succeeds, and every other call gets a
 * conflict. Use it when the caller adds its own input for the action, such
 * as a Slack card click, so one action adds one Turn. `exceptConversationId`
 * is the Conversation where the person acted. It gets the person's input
 * from its own surface, so it gets no message here. Slack cards of the item
 * change in place; see `syncReviewItemSlackCards` for `getSlackAdapter`.
 */
export async function actOnReviewItem(args: {
  action: ReviewItemAction;
  answer?: UserInputAnswer;
  exceptConversationId?: string;
  firstCloseOnly?: boolean;
  getSlackAdapter?: () => SlackAdapter;
  id: string;
  nowMs?: number;
  queue: ConversationWorkQueue;
  user: User;
}): Promise<ReviewItem> {
  const { action, user } = args;
  const nowMs = args.nowMs ?? Date.now();
  const db = getDb();
  const item = await readReviewItemForUser(user, args.id);

  if (action === "take") {
    if (item.status !== "open") {
      throw new ReviewItemActionError("conflict", "Review item is closed.");
    }
    if (!canActOnReviewItem(item, user.id)) {
      throw new ReviewItemActionError(
        "forbidden",
        "Only an assignee can take this item.",
      );
    }
    // A retry after a failed send finds the User already the only assignee.
    // It still sends: each take message has a key, so only missing ones go.
    if (
      !isOnlyAssignee(item, user.id) &&
      !(await takeReviewItem(db, { id: item.id, nowMs, userId: user.id }))
    ) {
      throw new ReviewItemActionError("conflict", "Review item is closed.");
    }
    const taken = await readReviewItemForUser(user, item.id);
    await syncReviewItemSlackCards({
      getSlackAdapter: args.getSlackAdapter,
      itemId: taken.id,
    });
    await sendReviewItemMessages({
      change: reviewItemChange(action, user),
      exceptConversationId: args.exceptConversationId,
      item: taken,
      nowMs,
      queue: args.queue,
    });
    return taken;
  }

  let closed = item;
  let closedNow = false;
  if (item.status === "open") {
    if (!canActOnReviewItem(item, user.id)) {
      throw new ReviewItemActionError(
        "forbidden",
        "Only an assignee can act on this item.",
      );
    }
    if (action === "complete" && item.kind === "action") {
      throw new ReviewItemActionError(
        "invalid",
        "An action item needs an answer. Submit it or dismiss it.",
      );
    }
    const answer =
      action === "submit" ? submittedAnswer(item, args.answer) : undefined;
    closedNow = await closeReviewItem(db, {
      closedByUserId: user.id,
      id: item.id,
      nowMs,
      status: closedStatus(action),
      ...(answer ? { answer } : undefined),
    });
    closed = await readReviewItemForUser(user, item.id);
  }
  if (args.firstCloseOnly ? !closedNow : !isSameClose(closed, action, user)) {
    throw new ReviewItemActionError("conflict", "Review item is closed.");
  }
  await syncReviewItemSlackCards({
    getSlackAdapter: args.getSlackAdapter,
    itemId: closed.id,
  });
  await sendReviewItemMessages({
    change: reviewItemChange(action, user),
    exceptConversationId: args.exceptConversationId,
    item: closed,
    nowMs,
    queue: args.queue,
  });
  return closed;
}

/**
 * Return whether a reply from this User answers an open action item, or is
 * a retry of the reply from this User that closed it.
 */
function replyAnswers(item: ReviewItem, user: User | undefined): boolean {
  if (item.status !== "open") return item.closedBy?.userId === user?.id;
  if (item.assignedToEveryone) return false;
  if (item.assignees.length === 0) return true;
  return (
    user !== undefined &&
    item.assignees.some((assignee) => assignee.userId === user.id)
  );
}

/** Save a typed reply as the free-text answer of an action item. */
function replyAnswer(
  item: ReviewItem,
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
 * reply always reaches the agent. The reply text is saved as the `other`
 * answer of each closed item, so the item keeps what the person said.
 *
 * A reply closes an item only when all of these are true:
 * - The item is an open `action` item.
 * - The agent added it in this Conversation (`addedByConversationId`).
 * - The replier is an assigned User, or the item has no assignees. A Slack
 *   replier without a Junior User closes only items with no assignees.
 *
 * Items assigned to Everyone, or only to other people, stay open. They need
 * an answer on the card or the review desk. Each item closes as `done` with
 * `REVIEW_ITEM_REPLIED_REASON`, and the replier closes it. The reply itself
 * is the answer in this Conversation, so only the other linked
 * Conversations get a message. A click that closes the item first wins.
 * A retry of the reply, or a later reply from the same person, sends the
 * missing messages of the items that it closed. Each message has a key, so
 * a message that was sent does not go again.
 */
export async function closeReviewItemsAnsweredByReply(args: {
  conversationId: string;
  getSlackAdapter?: () => SlackAdapter;
  nowMs?: number;
  queue: ConversationWorkQueue;
  resolveUser: () => Promise<User | undefined>;
  text: string;
}): Promise<void> {
  const db = getDb();
  const items = await listReplyActionItems(db, args.conversationId);
  if (items.length === 0) return;
  const user = await args.resolveUser();
  const nowMs = args.nowMs ?? Date.now();
  for (const item of items.filter((candidate) =>
    replyAnswers(candidate, user),
  )) {
    let closedItem: ReviewItem | undefined = item;
    if (item.status === "open") {
      const answer = replyAnswer(item, args.text);
      const closed = await closeReviewItem(db, {
        ...(answer ? { answer } : undefined),
        id: item.id,
        nowMs,
        reason: REVIEW_ITEM_REPLIED_REASON,
        status: "done",
        ...(user ? { closedByUserId: user.id } : undefined),
      });
      if (!closed) continue;
      closedItem = await getReviewItem(db, item.id);
      if (!closedItem) continue;
      // Card sync is best effort, so a retry only needs to send messages.
      await syncReviewItemSlackCards({
        getSlackAdapter: args.getSlackAdapter,
        itemId: closedItem.id,
      });
    }
    await sendReviewItemMessages({
      change: {
        kind: "replied",
        who: user ? (user.displayName ?? user.email) : "A person",
      },
      exceptConversationId: args.conversationId,
      item: closedItem,
      nowMs,
      queue: args.queue,
    });
  }
}
