import type { User } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import {
  isEmptyUserInputAnswer,
  normalizeUserInputAnswer,
  type UserInputAnswer,
} from "@/chat/tools/runtime/user-input-request";
import { deliverReviewItemChange, type ReviewItemDelivery } from "./changes";
import type { ReviewItemChange } from "./messages";
import {
  canActOnReviewItem,
  canReadReviewItem,
  isOnlyAssignee,
  reviewItemReaderForUser,
} from "./access";
import {
  closeReviewItem,
  getReviewItem,
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

/** Return whether a closed item is the result of this same action. */
function isSameClose(
  item: ReviewItem,
  action: Exclude<ReviewItemAction, "take">,
  user: User,
): boolean {
  return (
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
 * as a card click in a chat thread, so one action adds one Turn.
 * `exceptConversationId` is the Conversation where the person acted. It gets
 * the person's input from its own surface, so it gets no message here.
 * `delivery` shows the change and sends the messages; see
 * `deliverReviewItemChange`.
 */
export async function actOnReviewItem(args: {
  action: ReviewItemAction;
  answer?: UserInputAnswer;
  delivery: ReviewItemDelivery;
  exceptConversationId?: string;
  firstCloseOnly?: boolean;
  id: string;
  nowMs?: number;
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
    await deliverReviewItemChange({
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
  await deliverReviewItemChange({
    change: reviewItemChange(action, user),
    delivery: args.delivery,
    exceptConversationId: args.exceptConversationId,
    item: closed,
    nowMs,
  });
  return closed;
}
