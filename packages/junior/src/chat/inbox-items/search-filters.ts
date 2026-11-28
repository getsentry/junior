import {
  and,
  eq,
  gt,
  ilike,
  inArray,
  lt,
  not,
  or,
  type SQL,
} from "drizzle-orm";
import { inboxItemOwnerKind } from "@/chat/inbox-items/owner";
import { inboxItemSnoozedBy } from "@/chat/inbox-snoozes/store";
import { juniorInboxItems } from "@/db/schema";
import {
  inboxItemAddedByAutomation,
  inboxItemAssignedTo,
  inboxItemForUser,
  inboxItemLinkedTo,
  inboxItemNeedsUser,
  inboxItemVisibleTo,
  type InboxItemReader,
} from "./access";
import { inboxItemBody, inboxItemTitle } from "./question-content";
import type { InboxItemOwnerKind, InboxItemStatus } from "./store";

/**
 * A position in the oldest-first order: the last item of a page. Search
 * returns the items after it.
 */
export interface InboxItemPosition {
  createdAt: Date;
  id: string;
}

/**
 * A position in the waiting-first order: the last item of a page, and
 * whether it needs the User. Search returns the items after it.
 */
export interface InboxItemWaitingPosition extends InboxItemPosition {
  needsUser: boolean;
}

/**
 * A position in the newest-closed-first order: the last closed item of a
 * page. Search returns the items closed before it.
 */
export interface InboxItemClosedPosition {
  closedAt: Date;
  id: string;
}

/** Filters for Inbox item search. Every filter is optional. */
export interface InboxItemFilters {
  /**
   * Return only the items after this position. Use it with `order: "oldest"`
   * and one status group, such as only open items, because open items sort
   * first.
   */
  after?: InboxItemPosition;
  /**
   * Return only the items after this position. Use it with
   * `order: { needsUserId }` and only open items.
   */
  afterWaiting?: InboxItemWaitingPosition;
  /** One assigned User, or Everyone. */
  assignee?: { everyone: true } | { userId: string };
  automationId?: string;
  /**
   * Return only the items closed before this position. Use it with
   * `order: "closed"` and closed statuses.
   */
  closedBefore?: InboxItemClosedPosition;
  conversationId?: string;
  /**
   * Drop the items that are assigned only to other people
   * (`inboxItemForUser`).
   */
  forUserId?: string;
  /** Keep only the items that this kind of owner owns. */
  ownerKind?: InboxItemOwnerKind;
  /** Drop the items in Inbox rows that this User snoozed. */
  awakeForUserId?: string;
  /** Keep only the items in Inbox rows that this User snoozed. */
  snoozedForUserId?: string;
  limit: number;
  /** Words to find in the title or body. */
  query?: string;
  /**
   * `oldest` sorts by creation, oldest first. `closed` sorts closed items by
   * when they closed, newest first. `{ needsUserId }` puts the items that
   * need that User first (`inboxItemNeedsUser`), then the rest, each group
   * newest created first. By default the newest change comes first.
   */
  order?: "closed" | "oldest" | { needsUserId: string };
  statuses: readonly InboxItemStatus[];
  subjectId?: string;
}

/** The SQL conditions of Inbox item search, from its filters. */
export function searchConditions(
  reader: InboxItemReader,
  filters: Omit<InboxItemFilters, "limit">,
): SQL[] {
  const conditions: SQL[] = [
    inboxItemVisibleTo(reader),
    inArray(juniorInboxItems.status, [...filters.statuses]),
  ];
  if (filters.after) {
    conditions.push(
      or(
        gt(juniorInboxItems.createdAt, filters.after.createdAt),
        and(
          eq(juniorInboxItems.createdAt, filters.after.createdAt),
          gt(juniorInboxItems.id, filters.after.id),
        ),
      )!,
    );
  }
  if (filters.afterWaiting) {
    if (typeof filters.order !== "object") {
      throw new Error("afterWaiting needs the waiting-first order");
    }
    const needs = inboxItemNeedsUser(filters.order.needsUserId);
    const { createdAt, id, needsUser } = filters.afterWaiting;
    const older = or(
      lt(juniorInboxItems.createdAt, createdAt),
      and(
        eq(juniorInboxItems.createdAt, createdAt),
        lt(juniorInboxItems.id, id),
      ),
    )!;
    conditions.push(
      needsUser ? or(not(needs), and(needs, older))! : and(not(needs), older)!,
    );
  }
  if (filters.closedBefore) {
    conditions.push(
      or(
        lt(juniorInboxItems.closedAt, filters.closedBefore.closedAt),
        and(
          eq(juniorInboxItems.closedAt, filters.closedBefore.closedAt),
          lt(juniorInboxItems.id, filters.closedBefore.id),
        ),
      )!,
    );
  }
  if (filters.subjectId) {
    conditions.push(eq(juniorInboxItems.subjectId, filters.subjectId));
  }
  if (filters.automationId) {
    conditions.push(inboxItemAddedByAutomation(filters.automationId));
  }
  if (filters.conversationId) {
    conditions.push(inboxItemLinkedTo(filters.conversationId));
  }
  if (filters.assignee) {
    conditions.push(
      "everyone" in filters.assignee
        ? eq(juniorInboxItems.assignedToEveryone, true)
        : inboxItemAssignedTo(filters.assignee.userId),
    );
  }
  if (filters.ownerKind) {
    conditions.push(eq(inboxItemOwnerKind(), filters.ownerKind));
  }
  if (filters.forUserId) {
    conditions.push(inboxItemForUser(filters.forUserId));
  }
  if (filters.awakeForUserId) {
    conditions.push(not(inboxItemSnoozedBy(filters.awakeForUserId)));
  }
  if (filters.snoozedForUserId) {
    conditions.push(inboxItemSnoozedBy(filters.snoozedForUserId));
  }
  if (filters.query) {
    const pattern = `%${filters.query.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(
      or(ilike(inboxItemTitle, pattern), ilike(inboxItemBody, pattern))!,
    );
  }
  return conditions;
}
