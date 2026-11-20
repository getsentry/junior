import { mapBounded } from "@/chat/fan-out";
import type {
  PluginReviewItems,
  PluginReviewNotice,
} from "@sentry/junior-plugin-api";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { PLUGIN_REVIEW_ITEM_KEY_PREFIX } from "@/chat/review-items/access";
import { getDb } from "@/chat/db";
import { readIdentityByIdFromSql } from "@/chat/plugins/viewer";
import type { JuniorDatabase } from "@/db/db";
import type { ShowReviewItem } from "./changes";
import { reviewItemRequestSchema, type ReviewItemRequest } from "./evidence";
import {
  closeReviewItem,
  getOpenReviewItemByDedupeKey,
  insertReviewItem,
  updateReviewItemContent,
  type ReviewItemContent,
} from "./store";

/**
 * Resolve the Users to assign. A plugin notice goes only to people in its
 * Conversation, public or private. Junior leaves out an Identity without a
 * User and a User who is not in the Conversation.
 */
async function assigneeUserIds(
  db: JuniorDatabase,
  identityIds: readonly string[],
  conversationId: string,
): Promise<string[]> {
  const userIds = await mapBounded(
    [...new Set(identityIds)],
    async (identityId) => {
      const user = (await readIdentityByIdFromSql(db, identityId))?.user;
      if (!user) return [];
      const access = (
        await readConversationAccessFromSql(db, [conversationId], user)
      ).get(conversationId);
      return access?.isParticipant ? [user.id] : [];
    },
  );
  return userIds.flat();
}

/** Field id of the one choice field of a plugin item with choices. */
export const PLUGIN_CHOICE_FIELD_ID = "choice";

/** The request that shows a plugin item's choices as one row of buttons. */
function choicesRequest(notice: PluginReviewNotice): ReviewItemRequest {
  return reviewItemRequestSchema.parse({
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
export function createPluginReviewItems(args: {
  conversationId: string;
  plugin: string;
  show: ShowReviewItem;
}): PluginReviewItems {
  const { conversationId, show } = args;
  const scopedKey = (dedupeKey: string) =>
    `${PLUGIN_REVIEW_ITEM_KEY_PREFIX}${args.plugin}:${dedupeKey}`;
  const readAccess = async (db: JuniorDatabase) => {
    const access = (
      await readConversationAccessFromSql(db, [conversationId])
    ).get(conversationId);
    if (!access) throw new Error(`Conversation ${conversationId} is not found`);
    return access;
  };
  return {
    async upsert(notice: PluginReviewNotice) {
      const db = getDb();
      const access = await readAccess(db);
      const existing = await getOpenReviewItemByDedupeKey(
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
        existing.addedByConversationId !== conversationId
      ) {
        throw new Error(
          "A private review item links only to the Conversation that added it",
        );
      }
      const content: ReviewItemContent = {
        assignedToEveryone: false,
        assigneeUserIds: await assigneeUserIds(
          db,
          notice.assigneeIdentityIds,
          conversationId,
        ),
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
      if (existing) {
        await updateReviewItemContent(db, {
          ...content,
          id: existing.id,
          nowMs: Date.now(),
        });
        await show(existing.id);
        return;
      }
      const item = await insertReviewItem(db, {
        ...content,
        addedByConversationId: conversationId,
        dedupeKey: scopedKey(notice.dedupeKey),
        nowMs: Date.now(),
        ...(access.tenant ? { tenant: access.tenant } : undefined),
      });
      // Undefined means a concurrent upsert added the item first.
      if (item) {
        await show(item.id);
      }
    },
    async close(input) {
      const db = getDb();
      const access = await readAccess(db);
      const item = await getOpenReviewItemByDedupeKey(
        db,
        scopedKey(input.dedupeKey),
        access.tenant,
      );
      if (!item) return;
      const closed = await closeReviewItem(db, {
        id: item.id,
        nowMs: Date.now(),
        reason: input.reason,
        status: input.status,
      });
      if (closed) {
        await show(item.id);
      }
    },
  };
}
