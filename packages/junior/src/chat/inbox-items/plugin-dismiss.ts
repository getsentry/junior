import { and, eq, gte, isNull, ne, notExists } from "drizzle-orm";
import type { User } from "@sentry/junior-plugin-api";
import { createPluginCodeChanges } from "@/chat/code/plugin-code-changes";
import { touchConversationDetail } from "@/chat/conversations/sql/detail-version";
import { getDb } from "@/chat/db";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { getPlugins } from "@/chat/plugins/hooks/registry";
import { basePluginContext } from "@/chat/plugins/hook-context";
import { juniorInboxItemAssignees, juniorInboxItems } from "@/db/schema";
import { inboxItemPlugin } from "./access";
import { leaveInboxItem } from "./deliveries";
import { ownerConversationId, type InboxItem } from "./store";

/**
 * Return whether the item's assignees hold roles on its object: its plugin
 * registered the subject kind with `assigneeRoles`. A role puts a person on
 * the item outside the owner Conversation, and a dismiss removes only them.
 */
export function hasAssigneeRoles(item: Pick<InboxItem, "subject">): boolean {
  const pluginName = inboxItemPlugin(item);
  if (!pluginName) return false;
  const own = item.subject.kind.slice(pluginName.length + 1);
  return Boolean(
    getPlugins()
      .find((plugin) => plugin.manifest.name === pluginName)
      ?.inboxSubjects?.find((subject) => subject.kind === own)?.assigneeRoles,
  );
}

/**
 * Let the plugin remove the person who dismissed an `assigneeRoles` item from
 * the object on its provider, such as from a GitHub issue's assignees. Throws
 * when the plugin fails, so the dismiss fails and the person stays.
 */
export async function dismissPluginInboxItem(args: {
  item: InboxItem;
  nowMs: number;
  user: User;
}): Promise<void> {
  const { item, user } = args;
  const pluginName = inboxItemPlugin(item);
  // A plugin adds items only for a Conversation.
  const conversationId = ownerConversationId(item);
  if (!pluginName || !conversationId) return;
  const plugin = getPlugins().find((p) => p.manifest.name === pluginName);
  const hook = plugin?.hooks?.inboxItemDismissed;
  if (!plugin || !hook) return;
  // A plugin's provider Identities carry its name, such as `github`.
  const handle = user.identities.find(
    (identity) => identity.provider === pluginName,
  )?.handle;
  await hook({
    ...basePluginContext(plugin),
    annotations: createPluginAnnotations({
      conversationId,
      db: getDb(),
      plugin: pluginName,
    }),
    codeChanges: createPluginCodeChanges(pluginName),
    conversationId,
    ...(handle ? { handle } : undefined),
    nowMs: args.nowMs,
    subject: {
      id: item.subject.id,
      kind: item.subject.kind.slice(pluginName.length + 1),
    },
  });
}

/**
 * Take one User off an open item that others stay on. Junior cancels their
 * snooze and clears their push, as when an upsert drops them. Return `last`
 * and change nothing when nobody else is on the item, so the caller closes
 * it, and `closed` when it is closed. The row lock orders two dismisses at
 * once, so the second one sees that it is the last.
 */
export async function leavePluginInboxItem(args: {
  item: InboxItem;
  nowMs: number;
  userId: string;
}): Promise<"closed" | "last" | "left"> {
  const { item, nowMs, userId } = args;
  const db = getDb();
  const outcome = await db.transaction(async (tx) => {
    const updated = await tx
      .update(juniorInboxItems)
      .set({ updatedAt: new Date(nowMs) })
      .where(
        and(
          eq(juniorInboxItems.id, item.id),
          eq(juniorInboxItems.status, "open"),
        ),
      )
      .returning({ id: juniorInboxItems.id });
    if (!updated[0]) return "closed";
    const [other] = await tx
      .select({ userId: juniorInboxItemAssignees.userId })
      .from(juniorInboxItemAssignees)
      .where(
        and(
          eq(juniorInboxItemAssignees.itemId, item.id),
          ne(juniorInboxItemAssignees.userId, userId),
        ),
      )
      .limit(1);
    if (!other) return "last";
    await tx
      .delete(juniorInboxItemAssignees)
      .where(
        and(
          eq(juniorInboxItemAssignees.itemId, item.id),
          eq(juniorInboxItemAssignees.userId, userId),
        ),
      );
    const owner = ownerConversationId(item);
    await touchConversationDetail(tx, owner ? [owner] : []);
    return "left";
  });
  if (outcome === "left") {
    await leaveInboxItem(db, { itemId: item.id, nowMs, userIds: [userId] });
  }
  return outcome;
}

/**
 * Make a plugin's close since `sinceMs` the dismiss of `userId`: while the
 * dismiss waited on the provider, the removal left nobody on the item.
 * Return false when a person closed it, it closed before the dismiss
 * began, or another person is still on it, such as for a closed issue.
 */
export async function takeOverPluginClose(args: {
  item: InboxItem;
  nowMs: number;
  sinceMs: number;
  userId: string;
}): Promise<boolean> {
  const { item, userId } = args;
  return await getDb().transaction(async (tx) => {
    const taken = await tx
      .update(juniorInboxItems)
      .set({
        closeReason: null,
        closedByUserId: userId,
        status: "dismissed",
        updatedAt: new Date(args.nowMs),
      })
      .where(
        and(
          eq(juniorInboxItems.id, item.id),
          eq(juniorInboxItems.status, "done"),
          isNull(juniorInboxItems.closedByUserId),
          gte(juniorInboxItems.closedAt, new Date(args.sinceMs)),
          // A close keeps its assignees, so another one means that this
          // removal did not leave the item empty.
          notExists(
            tx
              .select({ userId: juniorInboxItemAssignees.userId })
              .from(juniorInboxItemAssignees)
              .where(
                and(
                  eq(juniorInboxItemAssignees.itemId, item.id),
                  ne(juniorInboxItemAssignees.userId, userId),
                ),
              ),
          ),
        ),
      )
      .returning({ id: juniorInboxItems.id });
    if (!taken[0]) return false;
    const owner = ownerConversationId(item);
    await touchConversationDetail(tx, owner ? [owner] : []);
    return true;
  });
}
