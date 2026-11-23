import { publishAgentUpdate } from "@/chat/conversations/watch-events";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { mapBounded } from "@/chat/fan-out";
import type {
  PluginReviewNotice,
  PluginTurnInboxItems,
} from "@sentry/junior-plugin-api";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { PLUGIN_INBOX_ITEM_KEY_PREFIX } from "@/chat/inbox-items/access";
import { getDb } from "@/chat/db";
import { readIdentityByIdFromSql } from "@/chat/plugins/viewer";
import type { JuniorDatabase } from "@/db/db";
import type { ShowInboxItem } from "./changes";
import { inboxItemRequestSchema, type InboxItemRequest } from "./evidence";
import {
  closeInboxItem,
  getOpenInboxItemByDedupeKey,
  insertInboxItem,
  ownerConversationId,
  updateInboxItemContent,
  type InboxItemContent,
} from "./store";

/**
 * Resolve the User of each Identity that a plugin item can go to. A plugin
 * notice goes only to people in its Conversation, public or private. Junior
 * leaves out an Identity without a User and a User who is not in the
 * Conversation.
 */
async function assignableUsers(
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

/** The stored dedupe key of a plugin item: `plugin:<name>:<key>`. */
function pluginItemKey(plugin: string, dedupeKey: string): string {
  return `${PLUGIN_INBOX_ITEM_KEY_PREFIX}${plugin}:${dedupeKey}`;
}

async function readAccess(db: JuniorDatabase, conversationId: string) {
  const access = (
    await readConversationAccessFromSql(db, [conversationId])
  ).get(conversationId);
  if (!access) throw new Error(`Conversation ${conversationId} is not found`);
  return access;
}

/**
 * Close the open item of a plugin with the key, in the tenant of the
 * Conversation. Return the id of the item that closed, or undefined when no
 * item was open. Pass a transaction to save it with other changes. The
 * caller shows the item after the write.
 */
export async function closePluginInboxItem(
  db: JuniorDatabase,
  args: {
    conversationId: string;
    dedupeKey: string;
    plugin: string;
    reason: string;
    status: "done" | "dismissed";
  },
): Promise<string | undefined> {
  const access = await readAccess(db, args.conversationId);
  const item = await getOpenInboxItemByDedupeKey(
    db,
    pluginItemKey(args.plugin, args.dedupeKey),
    access.tenant,
  );
  if (!item) return undefined;
  const closed = await closeInboxItem(db, {
    id: item.id,
    nowMs: Date.now(),
    reason: args.reason,
    status: args.status,
  });
  return closed ? item.id : undefined;
}

/**
 * Connect a plugin to the Inbox for one Conversation. Dedupe keys are
 * `plugin:<name>:<key>`, so a plugin changes only its own items, and agents
 * cannot change them. A change sends no message to the Conversation. It
 * only shows the new state through `show`. An item is private when the
 * Conversation is not public.
 */
export function createPluginInboxItems(args: {
  conversationId: string;
  plugin: string;
  show: ShowInboxItem;
}): PluginTurnInboxItems {
  const { conversationId, show } = args;
  return {
    async assignable(identityIds) {
      return (await assignableUsers(getDb(), identityIds, conversationId)).map(
        (user) => user.identityId,
      );
    },
    async upsert(notice: PluginReviewNotice) {
      const db = getDb();
      const access = await readAccess(db, conversationId);
      const existing = await getOpenInboxItemByDedupeKey(
        db,
        pluginItemKey(args.plugin, notice.dedupeKey),
        access.tenant,
      );
      // An item from a private Conversation stays private.
      const isPrivate =
        access.visibility !== "public" || existing?.visibility === "private";
      if (
        existing &&
        isPrivate &&
        ownerConversationId(existing) !== conversationId
      ) {
        throw new Error(
          "A private inbox item links only to the Conversation that added it",
        );
      }
      const content: InboxItemContent = {
        assignedToEveryone: false,
        assigneeUserIds: (
          await assignableUsers(db, notice.assigneeIdentityIds, conversationId)
        ).map((user) => user.userId),
        body: notice.body,
        conversationIds: [
          ...new Set([conversationId, ...(existing?.conversationIds ?? [])]),
        ],
        // An item that waits on its assignees is an action: it needs them.
        kind: notice.waitsOnAssignees || notice.choices ? "action" : "notice",
        title: notice.title,
        visibility: isPrivate ? "private" : "public",
        ...(notice.choices ? { request: choicesRequest(notice) } : undefined),
        ...(notice.subject ? { subject: notice.subject } : undefined),
      };
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
      } else {
        const item = await insertInboxItem(db, {
          ...content,
          dedupeKey: pluginItemKey(args.plugin, notice.dedupeKey),
          owner: { id: conversationId, kind: "conversation" },
          nowMs: Date.now(),
          ...(access.tenant ? { tenant: access.tenant } : undefined),
        });
        // Undefined means a concurrent upsert added the item first.
        if (!item) return;
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
              text: content.request?.question ?? content.body,
            }),
          },
        );
      }
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
