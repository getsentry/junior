import { and, eq } from "drizzle-orm";
import {
  getDashboardConversationLink,
  getDashboardInboxItemLink,
} from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import { mapBounded } from "@/chat/fan-out";
import {
  claimInboxItemPush,
  clearInboxItemDeliveries,
  listInboxItemPushUserIds,
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
import type { JuniorDatabase } from "@/db/db";
import { juniorInboxItemSlackCards, juniorInboxItems } from "@/db/schema";
import { readNotificationPause } from "./pause";
import { notificationPreview } from "./preview";
import {
  readWebPushConfig,
  sendPushNotificationToUser,
  type PushNotificationKind,
  type WebPushConfig,
} from "./web-push";

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
 * already holds this push.
 */
async function deliverPush(args: {
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
  const reason = await skipReason(db, item.id, userId, nowMs);
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
 * show only in the Inbox. A Slack card already tells its thread, so an item
 * with one does not push.
 */
async function pushesToAssignees(db: JuniorDatabase, item: InboxItem) {
  return (
    item.kind === "action" &&
    !item.assignedToEveryone &&
    item.assignees.length > 0 &&
    !(await hasSlackCard(db, item.id))
  );
}

/**
 * Push a new open action to each of its assigned Users, once per User. The
 * delivery record stops a second push when the item shows again, such as
 * after a content change. A User outside their notification hours, or who
 * snoozed the item, gets no push for it. Push is optional UI, the same as a
 * Slack card: a failure is logged and never fails the change that caused
 * it, and nothing retries it.
 */
export async function syncInboxItemPush(itemId: string): Promise<void> {
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
      if (!(await pushesToAssignees(db, item))) return;
      const url = getDashboardInboxItemLink(item.id);
      if (!url) return;
      await withSpan(
        "notification.inbox_item.push",
        "notification.inbox_item.push",
        {},
        async () => {
          // Read the pause of only the Users that have no push yet.
          const pushed = await listInboxItemPushUserIds(db, item.id);
          const userIds = item.assignees
            .map((assignee) => assignee.userId)
            .filter((userId) => !pushed.has(userId));
          await mapBounded(userIds, (userId) =>
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
