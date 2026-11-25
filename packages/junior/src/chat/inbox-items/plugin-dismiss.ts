import { and, eq } from "drizzle-orm";
import type { User } from "@sentry/junior-plugin-api";
import { createPluginCodeChanges } from "@/chat/code/plugin-code-changes";
import { touchConversationDetail } from "@/chat/conversations/sql/detail-version";
import { getDb } from "@/chat/db";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import { basePluginContext } from "@/chat/plugins/hook-context";
import { juniorInboxItemAssignees, juniorInboxItems } from "@/db/schema";
import { inboxItemPlugin } from "./access";
import { leaveInboxItem } from "./deliveries";
import { ownerConversationId, type InboxItem } from "./store";

/**
 * Return whether a dismiss of the item removes only the person who
 * dismissed it: its plugin registered the subject kind with
 * `dismissLeaves`.
 */
export function dismissLeavesItem(item: Pick<InboxItem, "subject">): boolean {
  const pluginName = inboxItemPlugin(item);
  if (!pluginName) return false;
  const own = item.subject.kind.slice(pluginName.length + 1);
  return Boolean(
    getPlugins()
      .find((plugin) => plugin.manifest.name === pluginName)
      ?.inboxSubjects?.find((subject) => subject.kind === own)?.dismissLeaves,
  );
}

/**
 * Let the plugin remove the person who dismissed a `dismissLeaves` item from
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
 * snooze and clears their push, as when an upsert drops them. Return false
 * when the item is closed.
 */
export async function leavePluginInboxItem(args: {
  item: InboxItem;
  nowMs: number;
  userId: string;
}): Promise<boolean> {
  const { item, nowMs, userId } = args;
  const db = getDb();
  const left = await db.transaction(async (tx) => {
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
    if (!updated[0]) return false;
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
    return true;
  });
  if (left) {
    await leaveInboxItem(db, { itemId: item.id, nowMs, userIds: [userId] });
  }
  return left;
}
