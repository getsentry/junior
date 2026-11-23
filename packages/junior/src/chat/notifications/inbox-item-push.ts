import { and, eq, or } from "drizzle-orm";
import * as z from "zod";
import { getDashboardInboxItemLink } from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import { updateTimerIndex, type TimerIndex } from "@/chat/events/timer-index";
import { mapBounded } from "@/chat/fan-out";
import {
  claimInboxItemPush,
  clearInboxItemDeliveries,
  listInboxItemPushUserIds,
  recordInboxItemSlackCard,
  type InboxItemDeliverySkipReason,
} from "@/chat/inbox-items/deliveries";
import {
  getInboxItem,
  isInboxItemOpen,
  type InboxItem,
} from "@/chat/inbox-items/store";
import { inboxItemSnoozedBy } from "@/chat/inbox-snoozes/store";
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
 * Push an open item to one User once. `afterSlackCard`: the item's Slack
 * card posted a while ago, so a User active in Slack got Slack's own
 * notification and needs no push.
 */
async function pushToUser(
  db: JuniorDatabase,
  config: WebPushConfig,
  input: {
    afterSlackCard: boolean;
    item: InboxItem;
    url: string;
    userId: string;
  },
): Promise<void> {
  const { item, userId } = input;
  const nowMs = Date.now();
  const reason =
    (await skipReason(db, item.id, userId, nowMs)) ??
    (input.afterSlackCard && (await isActiveInSlack(db, userId))
      ? "slack_active"
      : undefined);
  const claimed = await claimInboxItemPush(db, {
    itemId: item.id,
    nowMs,
    skipReason: reason,
    userId,
  });
  if (!claimed) return;
  // A close that ran before the claim cleared no row for this User. Clear
  // it now and send nothing. A later close clears the claimed row itself.
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
  // The payload holds only a short plain-text preview.
  await sendPushNotificationToUser({
    config,
    db,
    kind: "inbox_item",
    payload: {
      body: notificationPreview(item.body),
      tag: item.id,
      title: item.title,
      url: input.url,
    },
    userId,
  });
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
        const nowMs = Date.now();
        const waiting = await recordInboxItemSlackCard(db, {
          itemId: item.id,
          nowMs,
          userIds,
        });
        /* oxlint-disable no-await-in-loop -- The timer index lock does not wait. */
        for (const userId of waiting) {
          await scheduleInboxItemPushTimer(
            pushTimerId(item.id, userId),
            nowMs + SLACK_CARD_PUSH_DELAY_MS,
          );
        }
        /* oxlint-enable no-await-in-loop */
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
              pushToUser(db, config, {
                afterSlackCard: false,
                item,
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
 * nothing.
 */
async function pushAfterSlackCard(
  db: JuniorDatabase,
  config: WebPushConfig,
  timerId: string,
): Promise<void> {
  const [itemId, userId] = pushTimerSchema.parse(JSON.parse(timerId));
  await runBestEffort(
    async () => {
      const item = await getInboxItem(db, itemId);
      if (!item || item.status !== "open" || !pushesToAssignees(item)) return;
      if (!item.assignees.some((assignee) => assignee.userId === userId)) {
        return;
      }
      const url = getDashboardInboxItemLink(item.id);
      if (!url) return;
      await withSpan(
        "notification.inbox_item.push",
        "notification.inbox_item.push",
        {},
        () =>
          pushToUser(db, config, { afterSlackCard: true, item, url, userId }),
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
  if (config) {
    await mapBounded(timerIds, (id) => pushAfterSlackCard(db, config, id));
  }
  /* oxlint-disable no-await-in-loop -- The timer index lock does not wait. */
  for (const id of timerIds) {
    await updateTimerIndex(state, INBOX_ITEM_PUSH_TIMER_INDEX, {
      id,
      kind: "remove",
    });
  }
  /* oxlint-enable no-await-in-loop */
}
