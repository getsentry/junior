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
  const scopedKey = (dedupeKey: string) =>
    `${PLUGIN_INBOX_ITEM_KEY_PREFIX}${args.plugin}:${dedupeKey}`;
  const readAccess = async (db: JuniorDatabase) => {
    const access = (
      await readConversationAccessFromSql(db, [conversationId])
    ).get(conversationId);
    if (!access) throw new Error(`Conversation ${conversationId} is not found`);
    return access;
  };
  return {
    async assignable(identityIds) {
      return (await assignableUsers(getDb(), identityIds, conversationId)).map(
        (user) => user.identityId,
      );
    },
    async upsert(notice: PluginReviewNotice) {
      const db = getDb();
      const access = await readAccess(db);
      const existing = await getOpenInboxItemByDedupeKey(
        db,
        scopedKey(notice.dedupeKey),
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
          dedupeKey: scopedKey(notice.dedupeKey),
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
      const db = getDb();
      const access = await readAccess(db);
      const item = await getOpenInboxItemByDedupeKey(
        db,
        scopedKey(input.dedupeKey),
        access.tenant,
      );
      if (!item) return false;
      const closed = await closeInboxItem(db, {
        id: item.id,
        nowMs: Date.now(),
        reason: input.reason,
        status: input.status,
      });
      if (closed) {
        await show(item.id);
      }
      return closed;
    },
  };
}
