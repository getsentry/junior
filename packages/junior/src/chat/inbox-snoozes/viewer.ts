import { randomUUID } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { mapBounded } from "@/chat/fan-out";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import {
  canActOnInboxItem,
  canUserReadInboxItem,
  inboxItemForUser,
  inboxItemReaderForUser,
  inboxItemReaderForUserInConversation,
  inboxItemVisibleTo,
} from "@/chat/inbox-items/access";
import { getInboxItem, ownerConversationId } from "@/chat/inbox-items/store";
import { readSubjectLinks, subjectKey } from "@/chat/inbox-items/subject-links";
import { questionLinks } from "@/chat/inbox-items/subjects";
import { juniorConversations } from "@/db/schema/conversations";
import {
  inboxItemRequest,
  itemQuestion,
} from "@/chat/inbox-items/question-content";
import { juniorInboxItems } from "@/db/schema/inbox-items";
import { juniorQuestions } from "@/db/schema/questions";
import {
  inboxItemInRow,
  inboxItemSnoozedBy,
  settleInboxSnoozes,
  snoozeInboxItems,
  snoozeTimerTrigger,
  unsnoozeInboxRow,
  type InboxSnoozeTriggerInput,
} from "./store";
import {
  snoozeSubjectResource,
  viewerSnoozeResource,
  type SnoozeResource,
} from "./subject";
import { scheduleInboxSnoozeTimer } from "./triggers";

/**
 * The Inbox row of a snooze: a root Conversation, one item in it, or one
 * item on its own.
 */
export type InboxSnoozeSubject =
  | { conversationId: string; inboxItemId?: string }
  | { conversationId?: undefined; inboxItemId: string };

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
  /** The viewer can close it (`canActOnInboxItem`). */
  canAct: boolean;
  id: string;
  /**
   * The web link that a snooze waits on by default: the item's subject,
   * such as a pull request, or for a question, its first related link.
   */
  subjectUrl: string | undefined;
}

/**
 * Return the open Inbox items of the row that the viewer can see: the one
 * item, in the root Conversation's row when a root is given, or every item
 * in the root Conversation's row. A missing row and a hidden row look the
 * same.
 */
async function visibleRowItems(
  user: User,
  root: string | undefined,
  inboxItemId: string | undefined,
): Promise<RowItem[]> {
  if (inboxItemId) {
    const item = await getInboxItem(getDb(), inboxItemId);
    const owner = item && ownerConversationId(item);
    const inRow =
      root === undefined ||
      (item
        ? await rootConversationIds([
            ...item.conversationIds,
            ...(owner ? [owner] : []),
          ])
        : []
      ).includes(root);
    if (
      item?.status === "open" &&
      inRow &&
      (await canUserReadInboxItem(item, user))
    ) {
      const links = await readSubjectLinks(getDb(), [item]);
      return [
        {
          canAct: canActOnInboxItem(item, user.id),
          id: item.id,
          subjectUrl: snoozeLink(item, links),
        },
      ];
    }
    return [];
  }
  if (!root) return [];
  const reader = await inboxItemReaderForUserInConversation(user, root);
  const rows = await getDb()
    .select({
      canAct: sql<boolean>`${inboxItemForUser(user.id)}`,
      id: juniorInboxItems.id,
      request: inboxItemRequest,
      subjectId: juniorInboxItems.subjectId,
      subjectKind: juniorInboxItems.subjectKind,
    })
    .from(juniorInboxItems)
    .leftJoin(juniorQuestions, itemQuestion)
    .where(
      and(
        eq(juniorInboxItems.status, "open"),
        inboxItemVisibleTo(reader),
        inboxItemInRow(root),
      ),
    );
  const items = rows.map((row) => ({
    request: row.request,
    subject: { id: row.subjectId, kind: row.subjectKind },
  }));
  const links = await readSubjectLinks(getDb(), items);
  return rows.map((row, index) => ({
    canAct: row.canAct,
    id: row.id,
    subjectUrl: snoozeLink(items[index]!, links),
  }));
}

/**
 * Return the link that a snooze of the item waits on by default. A
 * question's subject has no link, so it waits on what its first related
 * link names, such as a pull request. That does not decide its card.
 */
function snoozeLink(
  item: Parameters<typeof questionLinks>[0],
  links: ReadonlyMap<string, string>,
): string | undefined {
  return links.get(subjectKey(item.subject)) ?? questionLinks(item)[0];
}

/**
 * An Event that ends a snooze: `wake` shows the item again, and `resolve`
 * dismisses it. It is on the page at `resourceUrl`, or on each item's
 * subject.
 */
interface ViewerSnoozeTrigger {
  eventType: string;
  outcome: "wake" | "resolve";
  resourceUrl?: string;
}

/**
 * Read the resource of each page that the triggers name. The viewer must
 * be allowed to see each one, so a snooze cannot learn about a page that
 * they cannot see.
 */
async function namedResources(
  user: User,
  triggers: readonly ViewerSnoozeTrigger[],
): Promise<Map<string, SnoozeResource>> {
  const urls = [
    ...new Set(triggers.flatMap((trigger) => trigger.resourceUrl ?? [])),
  ];
  const catalog = getEventCatalog();
  const resources = await mapBounded(urls, (url) =>
    viewerSnoozeResource(user, catalog, url),
  );
  const named = new Map<string, SnoozeResource>();
  for (const [index, url] of urls.entries()) {
    const resource = resources[index];
    if (!resource) {
      throw new InboxSnoozeInputError(`A snooze cannot wait on ${url}.`);
    }
    named.set(url, resource);
  }
  return named;
}

/**
 * Aim each trigger at its named resource, or at the resource of the item's
 * subject. A viewer waits on the subject without a check, as the item
 * already names it. A `resolve` closes the item, so it needs a viewer
 * who can close it. Returns undefined when a trigger does not apply to
 * the item.
 */
function itemTriggers(
  item: RowItem,
  triggers: readonly ViewerSnoozeTrigger[],
  named: ReadonlyMap<string, SnoozeResource>,
): InboxSnoozeTriggerInput[] | undefined {
  const subject =
    item.subjectUrl &&
    snoozeSubjectResource(getEventCatalog(), item.subjectUrl);
  const aimed: InboxSnoozeTriggerInput[] = [];
  for (const trigger of triggers) {
    const resource = trigger.resourceUrl
      ? named.get(trigger.resourceUrl)
      : subject;
    if (
      !resource ||
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
  named: ReadonlyMap<string, SnoozeResource>,
): { item: RowItem; triggers: InboxSnoozeTriggerInput[] }[] {
  const taken = items.flatMap((item) => {
    const aimed = itemTriggers(item, triggers, named);
    return aimed ? [{ item, triggers: aimed }] : [];
  });
  if (taken.length === 0) {
    throw new InboxSnoozeInputError(
      "No item in the row takes these Events from this viewer.",
    );
  }
  return taken;
}

/**
 * Snooze the open items of one Inbox row for the viewer until `wakeAtMs`,
 * or until one of `triggers` fires on an item's subject or on a page that
 * the viewer names, whichever is first. With `untilClosed`, it has neither,
 * and lasts until the item closes or the viewer wakes it. Each item gets its own snooze, which replaces the viewer's
 * earlier one; a later item in the row shows by itself. Returns the
 * snoozed items.
 */
export async function createViewerSnooze(
  user: User,
  input: {
    subject: InboxSnoozeSubject;
    triggers?: readonly ViewerSnoozeTrigger[];
    /** No wake time and no trigger: it lasts until the item closes. */
    untilClosed?: true;
    wakeAtMs?: number;
  },
  nowMs = Date.now(),
): Promise<string[]> {
  const { wakeAtMs } = input;
  const ends = wakeAtMs !== undefined || Boolean(input.triggers?.length);
  if (ends === Boolean(input.untilClosed)) {
    throw new InboxSnoozeInputError(
      "Set a wake time or a trigger, or snooze until the item closes.",
    );
  }
  if (wakeAtMs !== undefined && wakeAtMs <= nowMs) {
    throw new InboxSnoozeInputError("The wake time must be in the future.");
  }
  const { conversationId, inboxItemId } = input.subject;
  const root =
    conversationId === undefined
      ? undefined
      : await rootConversationId(conversationId);
  const items =
    conversationId === undefined || root
      ? await visibleRowItems(user, root, inboxItemId)
      : [];
  if (items.length === 0) {
    throw new InboxRowNotFoundError("Inbox row was not found.");
  }
  const triggers = input.triggers ?? [];
  const snoozed = itemsWithTriggers(
    items,
    triggers,
    await namedResources(user, triggers),
  );
  const timerId =
    wakeAtMs === undefined ? undefined : `inbox-snooze:${randomUUID()}`;
  // Add the timer before the snoozes replace the viewer's earlier ones, so
  // a failed add leaves those snoozes and their timers as they were.
  if (timerId && wakeAtMs !== undefined) {
    await scheduleInboxSnoozeTimer(timerId, wakeAtMs);
  }
  const snoozeIds = await snoozeInboxItems(getDb(), {
    items: snoozed.map(({ item, triggers }) => ({
      inboxItemId: item.id,
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
    await settleInboxSnoozes(getDb(), {
      reason: { kind: "time" },
      snoozeIds,
      state: "woken",
    });
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
  const { conversationId, inboxItemId } = subject;
  if (inboxItemId) {
    await unsnoozeInboxRow(getDb(), { inboxItemId, userId: user.id });
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
    .from(juniorInboxItems)
    .where(
      and(
        eq(juniorInboxItems.status, "open"),
        inboxItemVisibleTo(inboxItemReaderForUser(user)),
        inboxItemForUser(user.id),
        inboxItemSnoozedBy(user.id),
      ),
    );
  return row?.count ?? 0;
}
