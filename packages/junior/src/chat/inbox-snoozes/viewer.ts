import { randomUUID } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import {
  canActOnReviewItem,
  canUserReadReviewItem,
  reviewItemForUser,
  reviewItemReaderForUser,
  reviewItemReaderForUserInConversation,
  reviewItemVisibleTo,
} from "@/chat/review-items/access";
import { getReviewItem } from "@/chat/review-items/store";
import { juniorConversations } from "@/db/schema/conversations";
import { juniorReviewItems } from "@/db/schema/review-items";
import {
  reviewItemInRow,
  reviewItemSnoozedBy,
  settleInboxSnoozes,
  snoozeInboxItems,
  snoozeTimerTrigger,
  unsnoozeInboxRow,
  type InboxSnoozeTriggerInput,
} from "./store";
import { snoozeSubjectResource } from "./subject";
import { scheduleInboxSnoozeTimer } from "./triggers";

/** The Inbox row of a snooze: a root Conversation, or one item in it. */
export interface InboxSnoozeSubject {
  conversationId: string;
  reviewItemId?: string;
}

/** A snooze request that the viewer may not make, such as a past time. */
export class InboxSnoozeInputError extends Error {}

/** The viewer cannot see the Inbox row, or it does not exist. */
export class InboxRowNotFoundError extends Error {}

async function rootConversationId(
  conversationId: string,
): Promise<string | undefined> {
  const [row] = await getDb()
    .select({
      conversationId: juniorConversations.conversationId,
      rootConversationId: juniorConversations.rootConversationId,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  return row ? (row.rootConversationId ?? row.conversationId) : undefined;
}

/** The root Conversations of these Conversations, in one read. */
async function rootConversationIds(
  conversationIds: string[],
): Promise<string[]> {
  if (conversationIds.length === 0) return [];
  const rows = await getDb()
    .select({
      conversationId: juniorConversations.conversationId,
      rootConversationId: juniorConversations.rootConversationId,
    })
    .from(juniorConversations)
    .where(inArray(juniorConversations.conversationId, conversationIds));
  return rows.map((row) => row.rootConversationId ?? row.conversationId);
}

/** An open item of an Inbox row, as a snooze of it reads it. */
interface RowItem {
  /** The viewer can dismiss it (`canActOnReviewItem`). */
  canAct: boolean;
  id: string;
  subjectUrl: string | null;
}

/**
 * Return the open Review items of the row that the viewer can see: the one
 * item, or every item in the root Conversation's row. A missing row and a
 * hidden row look the same.
 */
async function visibleRowItems(
  user: User,
  root: string,
  reviewItemId: string | undefined,
): Promise<RowItem[]> {
  if (reviewItemId) {
    const item = await getReviewItem(getDb(), reviewItemId);
    const roots = item ? await rootConversationIds(item.conversationIds) : [];
    if (
      item?.status === "open" &&
      roots.includes(root) &&
      (await canUserReadReviewItem(item, user))
    ) {
      return [
        {
          canAct: canActOnReviewItem(item, user.id),
          id: item.id,
          subjectUrl: item.subject?.url ?? null,
        },
      ];
    }
    return [];
  }
  const reader = await reviewItemReaderForUserInConversation(user, root);
  return getDb()
    .select({
      canAct: sql<boolean>`${reviewItemForUser(user.id)}`,
      id: juniorReviewItems.id,
      subjectUrl: juniorReviewItems.subjectUrl,
    })
    .from(juniorReviewItems)
    .where(
      and(
        eq(juniorReviewItems.status, "open"),
        reviewItemVisibleTo(reader),
        reviewItemInRow(root),
      ),
    );
}

/**
 * An Event on each snoozed item's subject that ends its snooze: `wake`
 * shows the item again, and `resolve` dismisses it.
 */
interface ViewerSnoozeTrigger {
  eventType: string;
  outcome: "wake" | "resolve";
}

/**
 * Aim each trigger at the resource of each item's subject. The item names
 * the resource, so a viewer cannot wait on a resource that no item they
 * see names. A `resolve` dismisses the item, so it needs a viewer who can
 * dismiss it.
 */
function subjectTriggers(
  items: readonly RowItem[],
  triggers: readonly ViewerSnoozeTrigger[],
): InboxSnoozeTriggerInput[][] {
  const catalog = getEventCatalog();
  return items.map((item) => {
    const resource =
      item.subjectUrl && snoozeSubjectResource(catalog, item.subjectUrl);
    return triggers.map((trigger) => {
      if (!resource || !resource.events.includes(trigger.eventType)) {
        throw new InboxSnoozeInputError(
          `An item in the row has no subject with ${trigger.eventType} Events.`,
        );
      }
      if (trigger.outcome === "resolve" && !item.canAct) {
        throw new InboxSnoozeInputError(
          "Only a person who can dismiss an item can resolve it on an Event.",
        );
      }
      return {
        eventType: trigger.eventType,
        identifier: resource.identifier,
        namespace: resource.namespace,
        outcome: trigger.outcome,
      };
    });
  });
}

/**
 * Snooze the open items of one Inbox row for the viewer until `wakeAtMs`,
 * or until one of `triggers` fires on an item's subject, whichever is
 * first. Each item gets its own snooze, which replaces the viewer's
 * earlier one; a later item in the row shows by itself. Returns the
 * snoozed items.
 */
export async function createViewerSnooze(
  user: User,
  input: {
    subject: InboxSnoozeSubject;
    triggers?: readonly ViewerSnoozeTrigger[];
    wakeAtMs?: number;
  },
  nowMs = Date.now(),
): Promise<string[]> {
  const { wakeAtMs } = input;
  if (wakeAtMs === undefined && !input.triggers?.length) {
    throw new InboxSnoozeInputError("Set a wake time or a trigger.");
  }
  if (wakeAtMs !== undefined && wakeAtMs <= nowMs) {
    throw new InboxSnoozeInputError("The wake time must be in the future.");
  }
  const root = await rootConversationId(input.subject.conversationId);
  const items = root
    ? await visibleRowItems(user, root, input.subject.reviewItemId)
    : [];
  if (!root || items.length === 0) {
    throw new InboxRowNotFoundError("Inbox row was not found.");
  }
  const eventTriggers = subjectTriggers(items, input.triggers ?? []);
  const timerId =
    wakeAtMs === undefined ? undefined : `inbox-snooze:${randomUUID()}`;
  // Add the timer before the snoozes replace the viewer's earlier ones, so
  // a failed add leaves those snoozes and their timers as they were.
  if (timerId && wakeAtMs !== undefined) {
    await scheduleInboxSnoozeTimer(timerId, wakeAtMs);
  }
  const snoozeIds = await snoozeInboxItems(getDb(), {
    items: items.map((item, index) => ({
      reviewItemId: item.id,
      triggers: [
        ...(timerId ? [snoozeTimerTrigger(timerId)] : []),
        ...eventTriggers[index]!,
      ],
    })),
    nowMs,
    userId: user.id,
  });
  // A heartbeat that claims the timer before the snoozes commit finds no
  // snooze and removes it. That can only happen once the wake time has
  // passed, so wake the snoozes here.
  if (wakeAtMs !== undefined && Date.now() >= wakeAtMs) {
    await settleInboxSnoozes(getDb(), { snoozeIds, state: "woken" });
  }
  return items.map((item) => item.id);
}

/**
 * Wake the viewer's snoozes on one Inbox row now. A row with no snooze of
 * theirs does not change.
 */
export async function unsnoozeViewerRow(
  user: User,
  subject: InboxSnoozeSubject,
): Promise<void> {
  const root = await rootConversationId(subject.conversationId);
  if (!root) return;
  await unsnoozeInboxRow(getDb(), {
    rootConversationId: root,
    ...(subject.reviewItemId
      ? { reviewItemId: subject.reviewItemId }
      : undefined),
    userId: user.id,
  });
}

/**
 * Count the open items that the viewer snoozed. Snoozed shows a card for
 * each, as a root Conversation's stack does.
 */
export async function countViewerSnoozes(user: User): Promise<number> {
  const [row] = await getDb()
    .select({ count: count() })
    .from(juniorReviewItems)
    .where(
      and(
        eq(juniorReviewItems.status, "open"),
        reviewItemVisibleTo(reviewItemReaderForUser(user)),
        reviewItemForUser(user.id),
        reviewItemSnoozedBy(user.id),
      ),
    );
  return row?.count ?? 0;
}
