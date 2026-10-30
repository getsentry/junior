import type { User } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  isEmptyUserInputAnswer,
  normalizeUserInputAnswer,
  type UserInputAnswer,
} from "@/chat/tools/runtime/user-input-request";
import { sendReviewItemMessages, type ReviewItemChange } from "./messages";
import {
  canReadReviewItem,
  reviewItemReaderForUser,
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

/**
 * Return whether a User can act on an open Review item: an assigned User,
 * anyone for an item assigned to Everyone, and anyone for an item with no
 * assignees. The caller checks that the User can see the item.
 */
export function canActOnReviewItem(item: ReviewItem, userId: string): boolean {
  if (item.status !== "open") return false;
  if (item.assignedToEveryone) return true;
  if (item.assignees.length === 0) return true;
  return item.assignees.some((assignee) => assignee.userId === userId);
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

function changeFor(
  action: Exclude<ReviewItemAction, "take">,
  user: User,
): ReviewItemChange {
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
 * succeeds, so a client can retry after a failure.
 */
export async function actOnReviewItem(args: {
  action: ReviewItemAction;
  answer?: UserInputAnswer;
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
    const onlyAssignee =
      !item.assignedToEveryone &&
      item.assignees.length === 1 &&
      item.assignees[0]?.userId === user.id;
    if (onlyAssignee) return item;
    if (!(await takeReviewItem(db, { id: item.id, nowMs, userId: user.id }))) {
      throw new ReviewItemActionError("conflict", "Review item is closed.");
    }
    const taken = await readReviewItemForUser(user, item.id);
    await sendReviewItemMessages({
      change: { kind: "taken", user },
      item: taken,
      nowMs,
      queue: args.queue,
    });
    return taken;
  }

  let closed = item;
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
    await closeReviewItem(db, {
      closedByUserId: user.id,
      id: item.id,
      nowMs,
      status: closedStatus(action),
      ...(answer ? { answer } : undefined),
    });
    closed = await readReviewItemForUser(user, item.id);
  }
  if (!isSameClose(closed, action, user)) {
    throw new ReviewItemActionError("conflict", "Review item is closed.");
  }
  await sendReviewItemMessages({
    change: changeFor(action, user),
    item: closed,
    nowMs,
    queue: args.queue,
  });
  return closed;
}
