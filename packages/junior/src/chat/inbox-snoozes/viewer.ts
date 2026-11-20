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

/**
 * The Inbox row of a snooze: a root Conversation, one item in it, or one
 * item on its own.
 */
export type InboxSnoozeSubject =
  | { conversationId: string; reviewItemId?: string }
  | { conversationId?: undefined; reviewItemId: string };

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
 * item, in the root Conversation's row when a root is given, or every item
 * in the root Conversation's row. A missing row and a hidden row look the
 * same.
 */
async function visibleRowItems(
  user: User,
  root: string | undefined,
  reviewItemId: string | undefined,
): Promise<RowItem[]> {
  if (reviewItemId) {
    const item = await getReviewItem(getDb(), reviewItemId);
    const inRow =
      root === undefined ||
      (item ? await rootConversationIds(item.conversationIds) : []).includes(
        root,
      );
    if (
      item?.status === "open" &&
      inRow &&
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
  if (!root) return [];
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
 * Aim each trigger at the resource of the item's subject. The item names
 * the resource, so a viewer cannot wait on a resource that no item they
 * see names. A `resolve` dismisses the item, so it needs a viewer who can
 * dismiss it. Returns undefined when a trigger does not apply to the item.
 */
function subjectTriggers(
  item: RowItem,
  triggers: readonly ViewerSnoozeTrigger[],
): InboxSnoozeTriggerInput[] | undefined {
  const resource =
    item.subjectUrl &&
    snoozeSubjectResource(getEventCatalog(), item.subjectUrl);
  if (!resource) return triggers.length > 0 ? undefined : [];
  const aimed: InboxSnoozeTriggerInput[] = [];
  for (const trigger of triggers) {
    if (
      !resource.events.includes(trigger.eventType) ||
      (trigger.outcome === "resolve" && !item.canAct)
    ) {
      return undefined;
    }
    aimed.push({
      eventType: trigger.eventType,
      identifier: resource.identifier,
      namespace: resource.namespace,
      outcome: trigger.outcome,
    });
  }
  return aimed;
}

/**
 * The row's items that take every trigger, each with its triggers. A root
 * row snoozes only those, as the Inbox can show fewer of its items than
 * the viewer can read, such as an item that an earlier snooze hides; the
 * rest stay as they are. Throws when no item takes them.
 */
function itemsWithTriggers(
  items: readonly RowItem[],
  triggers: readonly ViewerSnoozeTrigger[],
): { item: RowItem; triggers: InboxSnoozeTriggerInput[] }[] {
  const taken = items.flatMap((item) => {
    const aimed = subjectTriggers(item, triggers);
    return aimed ? [{ item, triggers: aimed }] : [];
  });
  if (taken.length === 0) {
    throw new InboxSnoozeInputError(
      "No item in the row has a subject with these Events that the viewer can act on.",
    );
  }
  return taken;
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
  const { conversationId, reviewItemId } = input.subject;
  const root =
    conversationId === undefined
      ? undefined
      : await rootConversationId(conversationId);
  const items =
    conversationId === undefined || root
      ? await visibleRowItems(user, root, reviewItemId)
      : [];
  if (items.length === 0) {
    throw new InboxRowNotFoundError("Inbox row was not found.");
  }
  const snoozed = itemsWithTriggers(items, input.triggers ?? []);
  const timerId =
    wakeAtMs === undefined ? undefined : `inbox-snooze:${randomUUID()}`;
  // Add the timer before the snoozes replace the viewer's earlier ones, so
  // a failed add leaves those snoozes and their timers as they were.
  if (timerId && wakeAtMs !== undefined) {
    await scheduleInboxSnoozeTimer(timerId, wakeAtMs);
  }
  const snoozeIds = await snoozeInboxItems(getDb(), {
    items: snoozed.map(({ item, triggers }) => ({
      reviewItemId: item.id,
      triggers: [
        ...(timerId ? [snoozeTimerTrigger(timerId)] : []),
        ...triggers,
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
  return snoozed.map(({ item }) => item.id);
}

/**
 * Wake the viewer's snoozes on one Inbox row now. A row with no snooze of
 * theirs does not change.
 */
export async function unsnoozeViewerRow(
  user: User,
  subject: InboxSnoozeSubject,
): Promise<void> {
  // One item wakes by its id alone. A root Conversation's row wakes as a
  // whole.
  const { conversationId, reviewItemId } = subject;
  if (reviewItemId) {
    await unsnoozeInboxRow(getDb(), { reviewItemId, userId: user.id });
    return;
  }
  const root = conversationId && (await rootConversationId(conversationId));
  if (!root) return;
  await unsnoozeInboxRow(getDb(), {
    rootConversationId: root,
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
