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
import {
  closeReviewItem,
  getOpenReviewItemByDedupeKey,
  insertReviewItem,
  updateReviewItemContent,
  type ReviewItemContent,
} from "./store";

/**
 * Resolve the Users to assign. An Identity without a User has no one to
 * assign. A private item goes only to people in its Conversation, the same
 * rule that `requireReviewItemAssignees` applies to agents.
 */
async function assigneeUserIds(
  db: JuniorDatabase,
  identityIds: readonly string[],
  conversationId: string,
  isPrivate: boolean,
): Promise<string[]> {
  const userIds: string[] = [];
  for (const identityId of new Set(identityIds)) {
    const user = (await readIdentityByIdFromSql(db, identityId))?.user;
    if (!user) continue;
    if (
      isPrivate &&
      !(await readConversationAccessFromSql(db, [conversationId], user)).get(
        conversationId,
      )?.isParticipant
    ) {
      throw new Error(
        "A private review item can be assigned only to people in its Conversation",
      );
    }
    userIds.push(user.id);
  }
  return userIds;
}

/**
 * Connect a plugin to the review desk for one Conversation. Dedupe keys are
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
          isPrivate,
        ),
        body: notice.body,
        conversationIds: [
          ...new Set([conversationId, ...(existing?.conversationIds ?? [])]),
        ],
        kind: "notice",
        title: notice.title,
        visibility: isPrivate ? "private" : "public",
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
