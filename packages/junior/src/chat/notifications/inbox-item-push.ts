import { and, eq, or } from "drizzle-orm";
import * as z from "zod";
import {
  getDashboardConversationLink,
  getDashboardInboxItemLink,
} from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import { updateTimerIndex, type TimerIndex } from "@/chat/events/timer-index";
import { mapBounded } from "@/chat/fan-out";
import {
  claimInboxItemPush,
  clearInboxItemDeliveries,
  listInboxItemPushUserIds,
  recordInboxItemSlackCard,
  recordRepeatInboxItemPush,
  type InboxItemDeliverySkipReason,
} from "@/chat/inbox-items/deliveries";
import { REPLY_NOTICE_KEY_PREFIX } from "@/chat/inbox-items/access";
import {
  getInboxItem,
  isInboxItemOpen,
  type InboxItem,
} from "@/chat/inbox-items/store";
import {
  inboxItemSnoozedBy,
  type SettledInboxSnooze,
} from "@/chat/inbox-snoozes/store";
import { logInfo, runBestEffort, withSpan } from "@/chat/logging";
import { getStateAdapter } from "@/chat/state/adapter";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorInboxItemConversations,
  juniorInboxItemSlackCards,
  juniorInboxItems,
} from "@/db/schema";
import { readNotificationPause } from "./pause";
import { notificationPreview } from "./preview";
import { isActiveInSlack } from "./slack";
import {
  readWebPushConfig,
  sendPushNotificationToUser,
  type PushNotificationKind,
  type WebPushConfig,
} from "./web-push";

/**
 * How long a Slack card waits before its item pushes. A User who saw the
 * card in that time answers it, which closes the item.
 */
const SLACK_CARD_PUSH_DELAY_MS = 5 * 60_000;

/** Pending pushes after a Slack card. Each id names one item and one User. */
const INBOX_ITEM_PUSH_TIMER_INDEX: TimerIndex = {
  batchSize: 100,
  key: "junior:inbox-items:push-due",
};

const pushTimerSchema = z.tuple([z.string(), z.string()]);

function pushTimerId(itemId: string, userId: string): string {
  return JSON.stringify([itemId, userId]);
}

async function scheduleInboxItemPushTimer(
  id: string,
  atMs: number,
): Promise<void> {
  const state = getStateAdapter();
  await state.connect();
  await updateTimerIndex(state, INBOX_ITEM_PUSH_TIMER_INDEX, {
    atMs,
    id,
    kind: "add",
  });
}

/**
 * Record the Slack card of an open item for each assignee, and keep a push
 * timer from their first card for each one with no push yet. A User
 * assigned again after their timer fired gets it again, and a timer that
 * is due already fires at the next heartbeat.
 */
async function scheduleSlackCardPushes(
  db: JuniorDatabase,
  item: InboxItem,
): Promise<void> {
  const carded = await recordInboxItemSlackCard(db, {
    itemId: item.id,
    nowMs: Date.now(),
    userIds: item.assignees.map((assignee) => assignee.userId),
  });
  const pushed = await listInboxItemPushUserIds(db, item.id);
  /* oxlint-disable no-await-in-loop -- The timer index lock does not wait. */
  for (const [userId, cardedAtMs] of carded) {
    if (pushed.has(userId)) continue;
    await scheduleInboxItemPushTimer(
      pushTimerId(item.id, userId),
      cardedAtMs + SLACK_CARD_PUSH_DELAY_MS,
    );
  }
  /* oxlint-enable no-await-in-loop */
}

async function hasSlackCard(db: JuniorDatabase, itemId: string) {
  const rows = await db
    .select({ itemId: juniorInboxItemSlackCards.itemId })
    .from(juniorInboxItemSlackCards)
    .where(eq(juniorInboxItemSlackCards.itemId, itemId))
    .limit(1);
  return rows.length > 0;
}

async function isSnoozedBy(db: JuniorDatabase, itemId: string, userId: string) {
  const rows = await db
    .select({ id: juniorInboxItems.id })
    .from(juniorInboxItems)
    .where(and(eq(juniorInboxItems.id, itemId), inboxItemSnoozedBy(userId)))
    .limit(1);
  return rows.length > 0;
}

async function skipReason(
  db: JuniorDatabase,
  itemId: string,
  userId: string,
  nowMs: number,
): Promise<InboxItemDeliverySkipReason | undefined> {
  if (await isSnoozedBy(db, itemId, userId)) return "snoozed";
  return await readNotificationPause(db, userId, nowMs);
}

/**
 * Record one push of an item to one User, then send it unless the User is
 * paused or snoozed the item. `record` returns false when another caller
 * already holds this push. `afterSlackCard`: the item's Slack card posted a
 * while ago, so a User active in Slack got Slack's own notification and
 * needs no push.
 */
async function deliverPush(args: {
  afterSlackCard?: boolean;
  config: WebPushConfig;
  db: JuniorDatabase;
  item: InboxItem;
  kind: PushNotificationKind;
  record: (input: {
    itemId: string;
    nowMs: number;
    skipReason: InboxItemDeliverySkipReason | undefined;
    userId: string;
  }) => Promise<boolean>;
  url: string;
  userId: string;
}): Promise<void> {
  const { db, item, userId } = args;
  const nowMs = Date.now();
  const reason =
    (await skipReason(db, item.id, userId, nowMs)) ??
    (args.afterSlackCard && (await isActiveInSlack(db, userId))
      ? "slack_active"
      : undefined);
  const recorded = await args.record({
    itemId: item.id,
    nowMs,
    skipReason: reason,
    userId,
  });
  if (!recorded) return;
  // A close that ran before the record cleared no row for this User. Clear
  // it now and send nothing. A later close clears the recorded row itself.
  if (!(await isInboxItemOpen(db, item.id))) {
    await clearInboxItemDeliveries(db, [item.id], Date.now());
    return;
  }
  if (reason) {
    logInfo("notification.inbox_item.skipped", {
      "app.notification.skip_reason": reason,
    });
    return;
  }
  // The payload holds only a short plain-text preview. The tag replaces an
  // earlier push of the item on the device.
  await sendPushNotificationToUser({
    config: args.config,
    db,
    kind: args.kind,
    payload: {
      body: notificationPreview(item.body),
      tag: item.id,
      title: item.title,
      url: args.url,
    },
    userId,
  });
}

/**
 * Only an action for named Users pushes. Everyone items and notices
 * show only in the Inbox.
 */
function pushesToAssignees(item: InboxItem) {
  return (
    item.kind === "action" &&
    !item.assignedToEveryone &&
    item.assignees.length > 0
  );
}

/**
 * Push a new open action to each of its assigned Users, once per User. The
 * delivery record stops a second push when the item shows again, such as
 * after a content change. An item with a Slack card records that card for
 * each User and pushes to them later, from `runInboxItemPushTimers`, unless
 * `slackWaited` says that its wait already ended. A
 * User outside their notification hours, or who snoozed the item, gets no
 * push for it. Push is optional UI, the same as a Slack card: a failure is
 * logged and never fails the change that caused it, and nothing retries
 * it.
 */
export async function syncInboxItemPush(
  itemId: string,
  options: { slackWaited?: boolean } = {},
): Promise<void> {
  const config = readWebPushConfig();
  if (!config) return;
  await runBestEffort(
    async () => {
      const db = getDb();
      const item = await getInboxItem(db, itemId);
      if (!item) return;
      // The close marks its deliveries cleared, but in its own statement.
      // A retry of the close shows the item again, so clear here too.
      if (item.status !== "open") {
        await clearInboxItemDeliveries(db, [item.id], Date.now());
        return;
      }
      if (!pushesToAssignees(item)) return;
      const url = getDashboardInboxItemLink(item.id);
      if (!url) return;
      const userIds = item.assignees.map((assignee) => assignee.userId);
      if (!options.slackWaited && (await hasSlackCard(db, item.id))) {
        await scheduleSlackCardPushes(db, item);
        return;
      }
      await withSpan(
        "notification.inbox_item.push",
        "notification.inbox_item.push",
        {},
        async () => {
          // Read the pause of only the Users that have no push yet.
          const pushed = await listInboxItemPushUserIds(db, item.id);
          await mapBounded(
            userIds.filter((userId) => !pushed.has(userId)),
            (userId) =>
              deliverPush({
                config,
                db,
                item,
                kind: "inbox_item",
                record: (input) => claimInboxItemPush(db, input),
                url,
                userId,
              }),
          );
        },
        { "app.inbox_item.id": item.id },
      );
    },
    "notification.inbox_item.push_failed",
    { "app.inbox_item.id": itemId },
  );
}

/**
 * Return where the wake push of an item opens, or undefined when the
 * item does not push to this User: they must be a named assignee of an
 * action, or the starter of a reply notice. A Slack card shows nothing new
 * when a snooze wakes, so it does not stop this push.
 */
function wakePushUrl(item: InboxItem, userId: string): string | undefined {
  if (item.status !== "open" || item.assignedToEveryone) return undefined;
  if (!item.assignees.some((assignee) => assignee.userId === userId)) {
    return undefined;
  }
  if (item.kind === "action") return getDashboardInboxItemLink(item.id);
  const [conversationId] = item.conversationIds;
  if (item.dedupeKey.startsWith(REPLY_NOTICE_KEY_PREFIX) && conversationId) {
    return getDashboardConversationLink(conversationId);
  }
  return undefined;
}

/**
 * Push each snooze that a time or an Event woke to the User who snoozed
 * it. The caller passes only the snoozes that its own update woke, so one
 * wake pushes once. A Wake that the User picks does not come here. Push is
 * optional UI: a failure is logged, and nothing retries it.
 */
export async function pushInboxSnoozeWakes(
  wakes: readonly SettledInboxSnooze[],
): Promise<void> {
  const config = readWebPushConfig();
  if (!config) return;
  await mapBounded(wakes, (wake) =>
    runBestEffort(
      async () => {
        const db = getDb();
        const item = await getInboxItem(db, wake.inboxItemId);
        const url = item && wakePushUrl(item, wake.userId);
        if (!item || !url) return;
        await withSpan(
          "notification.inbox_item.push",
          "notification.inbox_item.push",
          {},
          () =>
            deliverPush({
              config,
              db,
              item,
              kind: "wake",
              record: async (input) => {
                await recordRepeatInboxItemPush(db, {
                  ...input,
                  event: "wake",
                });
                return true;
              },
              url,
              userId: wake.userId,
            }),
          { "app.inbox_item.id": item.id },
        );
      },
      "notification.inbox_item.push_failed",
      { "app.inbox_item.id": wake.inboxItemId },
    ),
  );
}

/**
 * Push the open items of a root Conversation and its child agents now,
 * after the root attaches to or detaches from its Slack thread. Those items
 * count as having waited in Slack with no answer, so they skip the rest of
 * the Slack card wait. A User that an item pushed to already gets no
 * second push.
 */
export async function pushConversationInboxItemsNow(
  rootConversationId: string,
): Promise<void> {
  if (!readWebPushConfig()) return;
  await runBestEffort(
    async () => {
      const rows = await getDb()
        .selectDistinct({ itemId: juniorInboxItemConversations.itemId })
        .from(juniorInboxItemConversations)
        .innerJoin(
          juniorConversations,
          eq(
            juniorConversations.conversationId,
            juniorInboxItemConversations.conversationId,
          ),
        )
        .innerJoin(
          juniorInboxItems,
          eq(juniorInboxItems.id, juniorInboxItemConversations.itemId),
        )
        .where(
          and(
            eq(juniorInboxItems.status, "open"),
            or(
              eq(juniorConversations.conversationId, rootConversationId),
              eq(juniorConversations.rootConversationId, rootConversationId),
            ),
          ),
        );
      await mapBounded(rows, (row) =>
        syncInboxItemPush(row.itemId, { slackWaited: true }),
      );
    },
    "notification.inbox_item.push_failed",
    { "app.conversation.id": rootConversationId },
  );
}

/**
 * Push the item of one due timer to its User, after the item's Slack card
 * waited for them. A closed item, or a User no longer assigned, gets
 * nothing. An item whose User is not assigned goes in `unassigned`.
 */
async function pushAfterSlackCard(
  db: JuniorDatabase,
  config: WebPushConfig,
  timerId: string,
  unassigned: Set<string>,
): Promise<void> {
  const [itemId, userId] = pushTimerSchema.parse(JSON.parse(timerId));
  await runBestEffort(
    async () => {
      const item = await getInboxItem(db, itemId);
      if (!item || item.status !== "open" || !pushesToAssignees(item)) return;
      if (!item.assignees.some((assignee) => assignee.userId === userId)) {
        unassigned.add(item.id);
        return;
      }
      const url = getDashboardInboxItemLink(item.id);
      if (!url) return;
      await withSpan(
        "notification.inbox_item.push",
        "notification.inbox_item.push",
        {},
        () =>
          deliverPush({
            afterSlackCard: true,
            config,
            db,
            item,
            kind: "inbox_item",
            record: (input) => claimInboxItemPush(db, input),
            url,
            userId,
          }),
        { "app.inbox_item.id": item.id },
      );
    },
    "notification.inbox_item.push_failed",
    { "app.inbox_item.id": itemId },
  );
}

/**
 * Push the items whose Slack card waited long enough. A failed pass leaves
 * its claims to expire, so the next heartbeat retries them. A push that
 * fails is logged and not retried, the same as one that sends at once.
 * A User assigned again while the pass holds the claim of their timer
 * gets it again from the show, and the removal then drops it. So the pass
 * adds back the timers of each item with a User who was not assigned.
 */
export async function runInboxItemPushTimers(
  db: JuniorDatabase,
  nowMs: number,
): Promise<void> {
  const state = getStateAdapter();
  await state.connect();
  const timerIds = await updateTimerIndex(state, INBOX_ITEM_PUSH_TIMER_INDEX, {
    kind: "claim",
    nowMs,
  });
  if (timerIds.length === 0) return;
  const config = readWebPushConfig();
  const unassigned = new Set<string>();
  if (config) {
    await mapBounded(timerIds, (id) =>
      pushAfterSlackCard(db, config, id, unassigned),
    );
  }
  /* oxlint-disable no-await-in-loop -- The timer index lock does not wait. */
  for (const id of timerIds) {
    await updateTimerIndex(state, INBOX_ITEM_PUSH_TIMER_INDEX, {
      id,
      kind: "remove",
    });
  }
  for (const itemId of unassigned) {
    await runBestEffort(
      async () => {
        const item = await getInboxItem(db, itemId);
        if (
          item?.status === "open" &&
          pushesToAssignees(item) &&
          (await hasSlackCard(db, item.id))
        ) {
          await scheduleSlackCardPushes(db, item);
        }
      },
      "notification.inbox_item.push_failed",
      { "app.inbox_item.id": itemId },
    );
  }
  /* oxlint-enable no-await-in-loop */
}
