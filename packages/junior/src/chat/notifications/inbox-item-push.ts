import { and, eq } from "drizzle-orm";
import { getDashboardInboxItemLink } from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import { mapBounded } from "@/chat/fan-out";
import {
  claimInboxItemPush,
  clearInboxItemDeliveries,
  listInboxItemPushUserIds,
  type InboxItemDeliverySkipReason,
} from "@/chat/inbox-items/deliveries";
import { getInboxItem, type InboxItem } from "@/chat/inbox-items/store";
import { inboxItemSnoozedBy } from "@/chat/inbox-snoozes/store";
import { logInfo, runBestEffort, withSpan } from "@/chat/logging";
import type { JuniorDatabase } from "@/db/db";
import { juniorInboxItemSlackCards, juniorInboxItems } from "@/db/schema";
import { readNotificationPause } from "./pause";
import { notificationPreview } from "./preview";
import { readWebPushConfig, sendPushNotificationToUser } from "./web-push";

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

async function isOpen(db: JuniorDatabase, itemId: string) {
  const rows = await db
    .select({ id: juniorInboxItems.id })
    .from(juniorInboxItems)
    .where(
      and(eq(juniorInboxItems.id, itemId), eq(juniorInboxItems.status, "open")),
    )
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
 * Only an open action for named Users pushes. Everyone items and notices
 * show only in the Inbox. A Slack card already tells its thread, so an item
 * with one does not push.
 */
async function pushesToAssignees(db: JuniorDatabase, item: InboxItem) {
  return (
    item.status === "open" &&
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
      if (!item || !(await pushesToAssignees(db, item))) return;
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
          await mapBounded(userIds, async (userId) => {
            const nowMs = Date.now();
            const reason = await skipReason(db, item.id, userId, nowMs);
            const claimed = await claimInboxItemPush(db, {
              itemId: item.id,
              nowMs,
              skipReason: reason,
              userId,
            });
            if (!claimed) return;
            // A close that ran before the claim cleared no row for this
            // User. Clear it now and send nothing. A later close clears
            // the claimed row itself.
            if (!(await isOpen(db, item.id))) {
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
                url,
              },
              userId,
            });
          });
        },
        { "app.inbox_item.id": item.id },
      );
    },
    "notification.inbox_item.push_failed",
    { "app.inbox_item.id": itemId },
  );
}
