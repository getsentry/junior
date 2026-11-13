import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  not,
  notLike,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { ProviderTenant } from "@/api/conversations/access";
import {
  reviewItemSnoozedBy,
  wakeAutomationsForNewItem,
  wakeAutomationsVersion,
} from "@/chat/wake-automations/store";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorReviewItemAssignees,
  juniorReviewItemConversations,
  juniorReviewItems,
  juniorUsers,
} from "@/db/schema";
import type {
  UserInputAnswer,
  UserInputRequest,
} from "@/chat/tools/runtime/user-input-request";
import {
  PLUGIN_REVIEW_ITEM_KEY_PREFIX,
  reviewItemAssignedTo,
  reviewItemForUser,
  reviewItemLinkedTo,
  reviewItemNeedsUser,
  reviewItemPlugin,
  reviewItemVisibleTo,
  type ReviewItemReader,
} from "./access";

type ReviewItemKind = "notice" | "action";

/**
 * Close reason of an action item that a person answered with a reply in
 * its thread instead of on the card or the review desk.
 */
export const REVIEW_ITEM_REPLIED_REASON = "Replied in thread";
export type ReviewItemStatus = "open" | "done" | "dismissed";
export type ReviewItemVisibility = "public" | "private";

/** The thing a Review item is about, such as a pull request. */
interface ReviewItemSubject {
  /** Stable id that Search matches, such as a URL. */
  id: string;
  title?: string;
  url?: string;
}

/** One assigned User of a Review item. */
export interface ReviewItemAssignee {
  displayName?: string;
  email: string;
  userId: string;
}

/** A Review item with its assignees and linked Conversations. */
export interface ReviewItem {
  addedByConversationId: string;
  /** Turn that added the item. Unset for a plugin item. */
  addedByTurnId?: string;
  answer?: UserInputAnswer;
  assignedToEveryone: boolean;
  assignees: ReviewItemAssignee[];
  automationId?: string;
  closeReason?: string;
  closedAt?: Date;
  closedBy?: ReviewItemAssignee;
  conversationIds: string[];
  createdAt: Date;
  dedupeKey: string;
  id: string;
  kind: ReviewItemKind;
  request?: UserInputRequest;
  status: ReviewItemStatus;
  subject?: ReviewItemSubject;
  /** Provider tenant of the Conversation that added the item. */
  tenant?: ProviderTenant;
  title: string;
  body: string;
  updatedAt: Date;
  visibility: ReviewItemVisibility;
}

/** The fields an agent sets when it adds or changes a Review item. */
export interface ReviewItemContent {
  assignedToEveryone: boolean;
  assigneeUserIds: string[];
  body: string;
  conversationIds: string[];
  kind: ReviewItemKind;
  request?: UserInputRequest;
  subject?: ReviewItemSubject;
  title: string;
  visibility: ReviewItemVisibility;
}

type ItemRow = typeof juniorReviewItems.$inferSelect;

async function readUsers(
  db: JuniorDatabase,
  userIds: readonly string[],
): Promise<Map<string, ReviewItemAssignee>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({
      displayName: juniorUsers.displayName,
      email: juniorUsers.primaryEmail,
      userId: juniorUsers.id,
    })
    .from(juniorUsers)
    .where(inArray(juniorUsers.id, [...new Set(userIds)]));
  return new Map(
    rows.map((row) => [
      row.userId,
      {
        email: row.email,
        userId: row.userId,
        ...(row.displayName ? { displayName: row.displayName } : undefined),
      },
    ]),
  );
}

async function hydrate(
  db: JuniorDatabase,
  rows: readonly ItemRow[],
): Promise<ReviewItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [assigneeRows, conversationRows] = await Promise.all([
    db
      .select()
      .from(juniorReviewItemAssignees)
      .where(inArray(juniorReviewItemAssignees.itemId, ids)),
    db
      .select()
      .from(juniorReviewItemConversations)
      .where(inArray(juniorReviewItemConversations.itemId, ids)),
  ]);
  const users = await readUsers(db, [
    ...assigneeRows.map((row) => row.userId),
    ...rows.flatMap((row) => (row.closedByUserId ? [row.closedByUserId] : [])),
  ]);
  return rows.map((row) => {
    const closedBy = row.closedByUserId
      ? users.get(row.closedByUserId)
      : undefined;
    return {
      addedByConversationId: row.addedByConversationId,
      assignedToEveryone: row.assignedToEveryone,
      assignees: assigneeRows
        .filter((assignee) => assignee.itemId === row.id)
        .flatMap((assignee) => users.get(assignee.userId) ?? [])
        .sort((a, b) => a.email.localeCompare(b.email)),
      body: row.body,
      conversationIds: conversationRows
        .filter((link) => link.itemId === row.id)
        .map((link) => link.conversationId)
        .sort(),
      createdAt: row.createdAt,
      dedupeKey: row.dedupeKey,
      id: row.id,
      kind: row.kind,
      status: row.status,
      title: row.title,
      updatedAt: row.updatedAt,
      visibility: row.visibility,
      ...(row.answer ? { answer: row.answer } : undefined),
      ...(row.addedByTurnId ? { addedByTurnId: row.addedByTurnId } : undefined),
      ...(row.automationId ? { automationId: row.automationId } : undefined),
      ...(row.closeReason ? { closeReason: row.closeReason } : undefined),
      ...(row.closedAt ? { closedAt: row.closedAt } : undefined),
      ...(closedBy ? { closedBy } : undefined),
      ...(row.request ? { request: row.request } : undefined),
      ...(row.provider && row.providerTenantId
        ? {
            tenant: {
              provider: row.provider,
              providerTenantId: row.providerTenantId,
            },
          }
        : undefined),
      ...(row.subjectId
        ? {
            subject: {
              id: row.subjectId,
              ...(row.subjectTitle ? { title: row.subjectTitle } : undefined),
              ...(row.subjectUrl ? { url: row.subjectUrl } : undefined),
            },
          }
        : undefined),
    };
  });
}

function contentColumns(content: ReviewItemContent) {
  return {
    assignedToEveryone: content.assignedToEveryone,
    body: content.body,
    kind: content.kind,
    request: content.request ?? null,
    subjectId: content.subject?.id ?? null,
    subjectTitle: content.subject?.title ?? null,
    subjectUrl: content.subject?.url ?? null,
    title: content.title,
    visibility: content.visibility,
  };
}

async function replaceLinks(
  db: JuniorDatabase,
  itemId: string,
  content: Pick<ReviewItemContent, "assigneeUserIds" | "conversationIds">,
): Promise<void> {
  await db
    .delete(juniorReviewItemAssignees)
    .where(eq(juniorReviewItemAssignees.itemId, itemId));
  await db
    .delete(juniorReviewItemConversations)
    .where(eq(juniorReviewItemConversations.itemId, itemId));
  const userIds = [...new Set(content.assigneeUserIds)];
  if (userIds.length > 0) {
    await db
      .insert(juniorReviewItemAssignees)
      .values(userIds.map((userId) => ({ itemId, userId })));
  }
  const conversationIds = [...new Set(content.conversationIds)];
  if (conversationIds.length > 0) {
    await db
      .insert(juniorReviewItemConversations)
      .values(
        conversationIds.map((conversationId) => ({ itemId, conversationId })),
      );
  }
}

/** Read one Review item by id. */
export async function getReviewItem(
  db: JuniorDatabase,
  id: string,
): Promise<ReviewItem | undefined> {
  const rows = await db
    .select()
    .from(juniorReviewItems)
    .where(eq(juniorReviewItems.id, id));
  return (await hydrate(db, rows))[0];
}

/**
 * Read the action items that the agent added in one Conversation and that a
 * reply can answer: the open items, and the items that a reply closed. A
 * plugin's items are left out: the plugin closes them when its provider
 * state changes, such as when a pull request merges.
 */
export async function listReplyActionItems(
  db: JuniorDatabase,
  conversationId: string,
): Promise<ReviewItem[]> {
  const rows = await db
    .select()
    .from(juniorReviewItems)
    .where(
      and(
        eq(juniorReviewItems.addedByConversationId, conversationId),
        eq(juniorReviewItems.kind, "action"),
        notLike(
          juniorReviewItems.dedupeKey,
          `${PLUGIN_REVIEW_ITEM_KEY_PREFIX}%`,
        ),
        or(
          eq(juniorReviewItems.status, "open"),
          eq(juniorReviewItems.closeReason, REVIEW_ITEM_REPLIED_REASON),
        ),
      ),
    );
  return await hydrate(db, rows);
}

/**
 * Read the open Review item with one dedupe key in one provider tenant, if
 * there is one. Dedupe keys are unique only inside a tenant.
 */
export async function getOpenReviewItemByDedupeKey(
  db: JuniorDatabase,
  dedupeKey: string,
  tenant: ProviderTenant | undefined,
): Promise<ReviewItem | undefined> {
  const rows = await db
    .select()
    .from(juniorReviewItems)
    .where(
      and(
        eq(juniorReviewItems.dedupeKey, dedupeKey),
        eq(juniorReviewItems.status, "open"),
        tenant
          ? and(
              eq(juniorReviewItems.provider, tenant.provider),
              eq(juniorReviewItems.providerTenantId, tenant.providerTenantId),
            )
          : isNull(juniorReviewItems.provider),
      ),
    );
  return (await hydrate(db, rows))[0];
}

/**
 * Add one open Review item. Return undefined when another open item in the
 * same tenant already uses its dedupe key.
 */
export async function insertReviewItem(
  db: JuniorDatabase,
  input: ReviewItemContent & {
    addedByConversationId: string;
    addedByTurnId?: string;
    automationId?: string;
    dedupeKey: string;
    nowMs: number;
    tenant?: ProviderTenant;
  },
): Promise<ReviewItem | undefined> {
  const now = new Date(input.nowMs);
  const id = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(juniorReviewItems)
      .values({
        ...contentColumns(input),
        addedByConversationId: input.addedByConversationId,
        addedByTurnId: input.addedByTurnId ?? null,
        automationId: input.automationId ?? null,
        createdAt: now,
        dedupeKey: input.dedupeKey,
        id: randomUUID(),
        provider: input.tenant?.provider ?? null,
        providerTenantId: input.tenant?.providerTenantId ?? null,
        status: "open",
        updatedAt: now,
      })
      // The only possible conflict is the open dedupe index. It is an
      // expression index, so the statement names no target.
      .onConflictDoNothing()
      .returning({ id: juniorReviewItems.id });
    if (!inserted[0]) return undefined;
    await replaceLinks(tx, inserted[0].id, input);
    await wakeAutomationsForNewItem(tx, {
      itemId: inserted[0].id,
      nowMs: input.nowMs,
    });
    return inserted[0].id;
  });
  if (!id) return undefined;
  const item = await getReviewItem(db, id);
  if (!item) throw new Error(`Review item ${id} is missing after insert`);
  return item;
}

/**
 * Replace the content of one open Review item. Return false when closed.
 * `addedByTurnId` moves the Turn pointer to the Turn that added the item
 * again; omit it to keep the stored Turn.
 */
export async function updateReviewItemContent(
  db: JuniorDatabase,
  input: ReviewItemContent & {
    addedByTurnId?: string;
    id: string;
    nowMs: number;
  },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const updated = await tx
      .update(juniorReviewItems)
      .set({
        ...contentColumns(input),
        updatedAt: new Date(input.nowMs),
        ...(input.addedByTurnId
          ? { addedByTurnId: input.addedByTurnId }
          : undefined),
      })
      .where(
        and(
          eq(juniorReviewItems.id, input.id),
          eq(juniorReviewItems.status, "open"),
        ),
      )
      .returning({ id: juniorReviewItems.id });
    if (!updated[0]) return false;
    await replaceLinks(tx, input.id, input);
    return true;
  });
}

/**
 * Close one open Review item. `closedByUserId` is the person who closed it,
 * and it is unset when an agent closes it. Return false when the item was
 * already closed, so only the first close wins.
 */
export async function closeReviewItem(
  db: JuniorDatabase,
  input: {
    answer?: UserInputAnswer;
    closedByUserId?: string;
    id: string;
    nowMs: number;
    reason?: string;
    status: "done" | "dismissed";
  },
): Promise<boolean> {
  const now = new Date(input.nowMs);
  const updated = await db
    .update(juniorReviewItems)
    .set({
      answer: input.answer ?? null,
      closeReason: input.reason ?? null,
      closedAt: now,
      closedByUserId: input.closedByUserId ?? null,
      status: input.status,
      updatedAt: now,
    })
    .where(
      and(
        eq(juniorReviewItems.id, input.id),
        eq(juniorReviewItems.status, "open"),
      ),
    )
    .returning({ id: juniorReviewItems.id });
  return updated.length > 0;
}

/**
 * Dismiss the open Review items that an Automation or a set of
 * Conversations added, when no agent can act on them any more. No person
 * closes them. It sends no message and does not change the Slack cards. A
 * close by Conversations skips the items of an Automation, because a later
 * run of the Automation can still change them. An Automation delete closes
 * those.
 */
export async function dismissOpenReviewItems(
  db: JuniorDatabase,
  input: { nowMs: number; reason: string } & (
    | { addedByConversationIds: readonly string[] }
    | { automationId: string }
  ),
): Promise<void> {
  const now = new Date(input.nowMs);
  await db
    .update(juniorReviewItems)
    .set({
      closeReason: input.reason,
      closedAt: now,
      status: "dismissed",
      updatedAt: now,
    })
    .where(
      and(
        eq(juniorReviewItems.status, "open"),
        "automationId" in input
          ? eq(juniorReviewItems.automationId, input.automationId)
          : and(
              inArray(juniorReviewItems.addedByConversationId, [
                ...input.addedByConversationIds,
              ]),
              isNull(juniorReviewItems.automationId),
            ),
      ),
    );
}

/**
 * Make one User the only assignee of an open Review item. Return false when
 * the item is closed.
 */
export async function takeReviewItem(
  db: JuniorDatabase,
  input: { id: string; nowMs: number; userId: string },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const updated = await tx
      .update(juniorReviewItems)
      .set({ assignedToEveryone: false, updatedAt: new Date(input.nowMs) })
      .where(
        and(
          eq(juniorReviewItems.id, input.id),
          eq(juniorReviewItems.status, "open"),
        ),
      )
      .returning({ id: juniorReviewItems.id });
    if (!updated[0]) return false;
    await tx
      .delete(juniorReviewItemAssignees)
      .where(eq(juniorReviewItemAssignees.itemId, input.id));
    await tx
      .insert(juniorReviewItemAssignees)
      .values({ itemId: input.id, userId: input.userId });
    return true;
  });
}

/**
 * A position in the oldest-first order: the last item of a page. Search
 * returns the items after it.
 */
export interface ReviewItemPosition {
  createdAt: Date;
  id: string;
}

/** Filters for Review item search. Every filter is optional. */
export interface ReviewItemFilters {
  /**
   * Return only the items after this position. Use it with `order: "oldest"`
   * and one status group, such as only open items, because open items sort
   * first.
   */
  after?: ReviewItemPosition;
  /** One assigned User, or Everyone. */
  assignee?: { everyone: true } | { userId: string };
  automationId?: string;
  conversationId?: string;
  /**
   * Drop the items that are assigned only to other people
   * (`reviewItemForUser`).
   */
  forUserId?: string;
  /** Drop the items in Inbox rows that this User snoozed. */
  awakeForUserId?: string;
  limit: number;
  /** Words to find in the title or body. */
  query?: string;
  /**
   * `oldest` sorts by creation, oldest first. By default the newest change
   * comes first.
   */
  order?: "oldest";
  statuses: readonly ReviewItemStatus[];
  subjectId?: string;
}

function searchConditions(
  reader: ReviewItemReader,
  filters: Omit<ReviewItemFilters, "limit">,
): SQL[] {
  const conditions: SQL[] = [
    reviewItemVisibleTo(reader),
    inArray(juniorReviewItems.status, [...filters.statuses]),
  ];
  if (filters.after) {
    conditions.push(
      or(
        gt(juniorReviewItems.createdAt, filters.after.createdAt),
        and(
          eq(juniorReviewItems.createdAt, filters.after.createdAt),
          gt(juniorReviewItems.id, filters.after.id),
        ),
      )!,
    );
  }
  if (filters.subjectId) {
    conditions.push(eq(juniorReviewItems.subjectId, filters.subjectId));
  }
  if (filters.automationId) {
    conditions.push(eq(juniorReviewItems.automationId, filters.automationId));
  }
  if (filters.conversationId) {
    conditions.push(reviewItemLinkedTo(filters.conversationId));
  }
  if (filters.assignee) {
    conditions.push(
      "everyone" in filters.assignee
        ? eq(juniorReviewItems.assignedToEveryone, true)
        : reviewItemAssignedTo(filters.assignee.userId),
    );
  }
  if (filters.forUserId) {
    conditions.push(reviewItemForUser(filters.forUserId));
  }
  if (filters.awakeForUserId) {
    conditions.push(
      not(reviewItemSnoozedBy(filters.awakeForUserId, Date.now())),
    );
  }
  if (filters.query) {
    const pattern = `%${filters.query.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(
      or(
        ilike(juniorReviewItems.title, pattern),
        ilike(juniorReviewItems.body, pattern),
      )!,
    );
  }
  return conditions;
}

/**
 * SQL: the Review item needs the User now: `reviewItemNeedsUser`, and the
 * User has not snoozed its Inbox row.
 */
function reviewItemNeedsUserNow(userId: string, nowMs: number): SQL {
  return and(
    reviewItemNeedsUser(userId),
    not(reviewItemSnoozedBy(userId, nowMs)),
  )!;
}

/**
 * Count the open Review items that need a User now
 * (`reviewItemNeedsUser`). A snoozed row does not count until it wakes.
 */
export async function countReviewItemsNeedingUser(
  db: JuniorDatabase,
  userId: string,
  nowMs = Date.now(),
): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(juniorReviewItems)
    .where(reviewItemNeedsUserNow(userId, nowMs));
  return rows[0]?.count ?? 0;
}

/**
 * Return a query for a token that changes when the open Review items that
 * need a User change. An item that is added or changed moves the newest
 * `updated_at`, and an item that closes, leaves the User, or is snoozed
 * changes the count. A new or undone snooze also changes the token.
 */
export function reviewItemsNeedingUserVersionQuery(
  db: JuniorDatabase,
  userId: string,
) {
  return db
    .select({
      version: sql<string>`concat_ws(':', count(*), max(${juniorReviewItems.updatedAt}), ${wakeAutomationsVersion(userId)})`,
    })
    .from(juniorReviewItems)
    .where(reviewItemNeedsUserNow(userId, Date.now()));
}

/**
 * Find the Review items that a reader can see. Open items come first, so
 * the limit never drops an open item for a closed one. Then the newest
 * change comes first: `updated_at`, then `id`, both descending. With
 * `order: "oldest"`, the oldest item comes first: `created_at`, then `id`,
 * both ascending. `after` pages through that order.
 */
export async function searchReviewItems(
  db: JuniorDatabase,
  reader: ReviewItemReader,
  filters: ReviewItemFilters,
): Promise<ReviewItem[]> {
  const rows = await db
    .select()
    .from(juniorReviewItems)
    .where(and(...searchConditions(reader, filters)))
    .orderBy(
      desc(eq(juniorReviewItems.status, "open")),
      ...(filters.order === "oldest"
        ? [asc(juniorReviewItems.createdAt), asc(juniorReviewItems.id)]
        : [desc(juniorReviewItems.updatedAt), desc(juniorReviewItems.id)]),
    )
    .limit(filters.limit);
  return await hydrate(db, rows);
}

/** One open Review item that a Conversation waits on a User for. */
type WaitingItem = {
  /** The plugin that added the item, such as `github`. Unset for an agent. */
  plugin?: string;
  title: string;
};

/** One Conversation that waits on a User, with its open Review items. */
export type WaitingConversation = {
  conversationId: string;
  /** Open Review items on this Conversation that need the User, newest first. */
  items: WaitingItem[];
  /** When the oldest of those items was added: when the wait began. */
  waitingSince: string;
};

/**
 * List the root Conversations that wait on a User: each root or one of its
 * child conversations is linked to an open item that needs the User
 * (`reviewItemNeedsUser`). An item that a child agent adds links the child,
 * and the feed lists only roots.
 */
export async function listWaitingConversations(
  db: JuniorDatabase,
  userId: string,
): Promise<WaitingConversation[]> {
  const rows = await db
    .selectDistinct({
      conversationId: sql<string>`coalesce(${juniorConversations.rootConversationId}, ${juniorReviewItemConversations.conversationId})`,
      itemId: juniorReviewItems.id,
      dedupeKey: juniorReviewItems.dedupeKey,
      title: juniorReviewItems.title,
      createdAt: juniorReviewItems.createdAt,
    })
    .from(juniorReviewItemConversations)
    .innerJoin(
      juniorReviewItems,
      eq(juniorReviewItems.id, juniorReviewItemConversations.itemId),
    )
    .leftJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorReviewItemConversations.conversationId,
      ),
    )
    .where(reviewItemNeedsUserNow(userId, Date.now()))
    .orderBy(desc(juniorReviewItems.createdAt), desc(juniorReviewItems.id));
  const waiting = new Map<string, WaitingConversation>();
  for (const row of rows) {
    const plugin = reviewItemPlugin(row.dedupeKey);
    const item = { title: row.title, ...(plugin ? { plugin } : undefined) };
    const current = waiting.get(row.conversationId);
    // Rows come newest first, so each later row is older.
    if (current) {
      current.items.push(item);
      current.waitingSince = row.createdAt.toISOString();
    } else
      waiting.set(row.conversationId, {
        conversationId: row.conversationId,
        items: [item],
        waitingSince: row.createdAt.toISOString(),
      });
  }
  return [...waiting.values()].sort((left, right) =>
    left.conversationId.localeCompare(right.conversationId),
  );
}
