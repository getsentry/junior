import { publishAgentUpdate } from "@/chat/conversations/watch-events";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { mapBounded } from "@/chat/fan-out";
import type {
  PluginInboxItemSubject,
  PluginInboxItems,
  PluginReviewNotice,
} from "@sentry/junior-plugin-api";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { getDb } from "@/chat/db";
import { getPlugins } from "@/chat/plugins/hooks/registry";
import { readIdentityByIdFromSql } from "@/chat/plugins/viewer";
import type { JuniorDatabase } from "@/db/db";
import type { ShowInboxItem } from "./changes";
import { inboxItemRequestSchema, type InboxItemRequest } from "./request";
import {
  closeInboxItem,
  getOpenInboxItemBySubject,
  insertInboxItem,
  ownerConversationId,
  updateInboxItemContent,
  type InboxItem,
  type InboxItemContent,
} from "./store";
import { leaveInboxItem, resetInboxItemPushes } from "./deliveries";
import { pluginSubjectKind, subjectKindLabel } from "./subjects";
import { inboxItemQuestion } from "@/chat/inbox-items/request";

/**
 * Resolve the Users to assign. A plugin notice goes only to people in its
 * Conversation, public or private. Junior leaves out an Identity without a
 * User and a User who is not in the Conversation.
 */
async function assigneeUsers(
  db: JuniorDatabase,
  identityIds: readonly string[],
  conversationId: string,
): Promise<Array<{ identityId: string; userId: string }>> {
  const users = await mapBounded(
    [...new Set(identityIds)],
    async (identityId) => {
      const user = (await readIdentityByIdFromSql(db, identityId))?.user;
      if (!user) return [];
      const access = (
        await readConversationAccessFromSql(db, [conversationId], user)
      ).get(conversationId);
      return access?.isParticipant ? [{ identityId, userId: user.id }] : [];
    },
  );
  return users.flat();
}

/** Whether an upsert would leave the open item as it is. */
function sameContent(item: InboxItem, content: InboxItemContent): boolean {
  const userIds = new Set(item.assignees.map((assignee) => assignee.userId));
  return (
    !item.assignedToEveryone &&
    item.title === content.title &&
    item.body === content.body &&
    item.kind === content.kind &&
    JSON.stringify(item.request) === JSON.stringify(content.request) &&
    item.conversationIds.length === content.conversationIds.length &&
    userIds.size === content.assigneeUserIds.length &&
    content.assigneeUserIds.every((userId) => userIds.has(userId))
  );
}

/** Why a plugin item closes when nobody on it has an ask now. */
const NOBODY_LEFT_REASON = "Nobody on the item has an ask now.";

/** Field id of the one choice field of a plugin item with choices. */
export const PLUGIN_CHOICE_FIELD_ID = "choice";

/** The request that shows a plugin item's choices as one row of buttons. */
function choicesRequest(notice: PluginReviewNotice): InboxItemRequest {
  return inboxItemRequestSchema.parse({
    question: notice.body,
    fields: [
      {
        id: PLUGIN_CHOICE_FIELD_ID,
        kind: "choice",
        label: notice.title,
        options: notice.choices,
      },
    ],
  });
}

/**
 * The stored subject of a plugin item: the plugin's own kind as
 * `<plugin>:<kind>`, so a plugin finds and changes only its own items.
 */
function pluginItemSubject(plugin: string, subject: PluginInboxItemSubject) {
  return { id: subject.id, kind: pluginSubjectKind(plugin, subject.kind) };
}

/** Throw when the plugin's owner table gives the item another Conversation. */
function requireOwner(item: InboxItem, conversationId: string): void {
  if (ownerConversationId(item) !== conversationId) {
    throw new Error(
      `Inbox item ${item.id} belongs to another Conversation than ${conversationId}`,
    );
  }
}

/**
 * Close the open item of a plugin's subject, which belongs to the
 * Conversation. Return the id of the item that closed, or undefined when no
 * item was open. Pass a transaction to save it with other changes. The
 * caller shows the item after the write.
 */
export async function closePluginInboxItem(
  db: JuniorDatabase,
  args: {
    conversationId: string;
    plugin: string;
    reason: string;
    subject: PluginInboxItemSubject;
    status: "done" | "dismissed";
  },
): Promise<string | undefined> {
  const item = await getOpenInboxItemBySubject(
    db,
    pluginItemSubject(args.plugin, args.subject),
  );
  if (!item) return undefined;
  requireOwner(item, args.conversationId);
  const closed = await closeInboxItem(db, {
    id: item.id,
    nowMs: Date.now(),
    reason: args.reason,
    status: args.status,
  });
  return closed ? item.id : undefined;
}

/**
 * Connect a plugin to the Inbox for one Conversation. Each item has one of
 * the plugin's registered subject kinds, stored as `<plugin>:<kind>`, so a
 * plugin changes only its own items, and agents cannot change them. A
 * change sends no message to the Conversation. It only shows the new state
 * through `show`. The plugin's owner table names the Conversation that owns
 * each item, and its Destination sets who can see the item.
 */
export function createPluginInboxItems(args: {
  conversationId: string;
  plugin: string;
  show: ShowInboxItem;
}): PluginInboxItems {
  const { conversationId, show } = args;
  // `retry` is false after a concurrent upsert added the item first.
  const upsert = async (
    notice: PluginReviewNotice,
    retry: boolean,
  ): Promise<void> => {
    const subject = pluginItemSubject(args.plugin, notice.subject);
    if (!subjectKindLabel(subject.kind, getPlugins())) {
      throw new Error(
        `Plugin "${args.plugin}" has no inbox subject kind "${notice.subject.kind}"`,
      );
    }
    const db = getDb();
    const existing = await getOpenInboxItemBySubject(db, subject);
    if (existing) requireOwner(existing, conversationId);
    const [withAsk, asked] = await Promise.all([
      assigneeUsers(db, notice.assigneeIdentityIds, conversationId),
      assigneeUsers(db, notice.askedIdentityIds, conversationId),
    ]);
    // A person joins only with the event that gives them an ask. The
    // others with an ask stay only when they are on the item already, so
    // a person who left does not come back until a new ask.
    const current = new Set(
      existing?.assignees.map((assignee) => assignee.userId),
    );
    const askedNow = new Set(asked.map((user) => user.userId));
    const userIds = withAsk
      .map((user) => user.userId)
      .filter((userId) => askedNow.has(userId) || current.has(userId));
    // The item closes when nobody is left: everyone with an ask left it,
    // or everyone who was on it no longer has one. One for nobody Junior
    // knows, such as a person with no linked account, stays open with no
    // assignees.
    if (userIds.length === 0 && (withAsk.length > 0 || current.size > 0)) {
      if (!existing) return;
      const itemId = await closePluginInboxItem(db, {
        conversationId,
        plugin: args.plugin,
        reason: NOBODY_LEFT_REASON,
        status: "done",
        subject: notice.subject,
      });
      if (itemId) await show(itemId);
      return;
    }
    const content: InboxItemContent = {
      assignedToEveryone: false,
      assigneeUserIds: userIds,
      body: notice.body,
      conversationIds: [
        ...new Set([conversationId, ...(existing?.conversationIds ?? [])]),
      ],
      // An item that waits on its assignees is an action: it needs them.
      kind: notice.waitsOnAssignees || notice.choices ? "action" : "notice",
      title: notice.title,
      subject,
      ...(notice.choices ? { request: choicesRequest(notice) } : undefined),
    };
    // A plugin may show the same item on each event. One with no change
    // and no new ask writes nothing and shows nothing.
    if (existing && askedNow.size === 0 && sameContent(existing, content)) {
      return;
    }
    let itemId: string;
    // False when the item closed after the read above. A closed item does
    // not make the Conversation wait.
    let open = true;
    if (existing) {
      open = await updateInboxItemContent(db, {
        ...content,
        id: existing.id,
        nowMs: Date.now(),
      });
      itemId = existing.id;
      if (open) {
        const kept = new Set(userIds);
        await leaveInboxItem(db, {
          itemId,
          nowMs: Date.now(),
          userIds: [...current].filter((userId) => !kept.has(userId)),
        });
        // A new ask on the same item pushes it to that person again, also
        // to a person who left it and now joins again.
        await resetInboxItemPushes(db, {
          itemId,
          userIds: userIds.filter((userId) => askedNow.has(userId)),
        });
      }
    } else {
      const item = await insertInboxItem(db, {
        ...content,
        owner: { id: conversationId, kind: "conversation" },
        nowMs: Date.now(),
      });
      // Undefined means a concurrent upsert added the item first. Apply
      // this change to that item, so the people this event asks join it.
      if (!item) {
        if (retry) await upsert(notice, false);
        return;
      }
      itemId = item.id;
    }
    await show(itemId);
    // An action item means the Conversation waits on a person, also when
    // an update makes a notice an action. The Event key is the item, so a
    // later update of the same action does not report it again.
    if (open && content.kind === "action") {
      await publishAgentUpdate(
        conversationId,
        { type: "waiting", inboxItemId: itemId },
        {
          queue: getVercelConversationWorkQueue(),
          update: async () => ({
            status: "waiting",
            text: inboxItemQuestion(content.request)?.question ?? content.body,
          }),
        },
      );
    }
  };
  return {
    async upsert(notice) {
      await upsert(notice, true);
    },
    async close(input) {
      const itemId = await closePluginInboxItem(getDb(), {
        ...input,
        conversationId,
        plugin: args.plugin,
      });
      if (!itemId) return false;
      await show(itemId);
      return true;
    },
  };
}
