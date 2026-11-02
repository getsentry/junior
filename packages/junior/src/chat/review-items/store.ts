import { randomUUID } from "node:crypto";
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
} from "drizzle-orm";
import type { ProviderTenant } from "@/api/conversations/access";
import type { JuniorDatabase } from "@/db/db";
import {
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
  reviewItemAssignedTo,
  reviewItemLinkedTo,
  reviewItemNeedsUser,
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
 * reply can answer: the open items, and the items that a reply closed.
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
    return inserted[0].id;
  });
  if (!id) return undefined;
  const item = await getReviewItem(db, id);
  if (!item) throw new Error(`Review item ${id} is missing after insert`);
  return item;
}

/** Replace the content of one open Review item. Return false when closed. */
export async function updateReviewItemContent(
  db: JuniorDatabase,
  input: ReviewItemContent & { id: string; nowMs: number },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const updated = await tx
      .update(juniorReviewItems)
      .set({ ...contentColumns(input), updatedAt: new Date(input.nowMs) })
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
 * A position in the search order: the last item of a page. Search returns
 * the items after it.
 */
export interface ReviewItemPosition {
  id: string;
  updatedAt: Date;
}

/** Filters for Review item search. Every filter is optional. */
export interface ReviewItemFilters {
  /**
   * Return only the items after this position. Use it with one status
   * group, such as only open items, because open items sort first.
   */
  after?: ReviewItemPosition;
  /** One assigned User, or Everyone. */
  assignee?: { everyone: true } | { userId: string };
  automationId?: string;
  conversationId?: string;
  limit: number;
  /** Words to find in the title or body. */
  query?: string;
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
        lt(juniorReviewItems.updatedAt, filters.after.updatedAt),
        and(
          eq(juniorReviewItems.updatedAt, filters.after.updatedAt),
          lt(juniorReviewItems.id, filters.after.id),
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

/** Count the open Review items that need a User (`reviewItemNeedsUser`). */
export async function countReviewItemsNeedingUser(
  db: JuniorDatabase,
  userId: string,
): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(juniorReviewItems)
    .where(reviewItemNeedsUser(userId));
  return rows[0]?.count ?? 0;
}

/**
 * Find the Review items that a reader can see. Open items come first, so
 * the limit never drops an open item for a closed one. Then the newest
 * change comes first: `updated_at`, then `id`, both descending. `after`
 * pages through that order.
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
      desc(juniorReviewItems.updatedAt),
      desc(juniorReviewItems.id),
    )
    .limit(filters.limit);
  return await hydrate(db, rows);
}

/**
 * List the Conversations that wait on a User: each is linked to an open item
 * that needs the User (`reviewItemNeedsUser`).
 */
export async function listWaitingConversationIds(
  db: JuniorDatabase,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({
      conversationId: juniorReviewItemConversations.conversationId,
    })
    .from(juniorReviewItemConversations)
    .innerJoin(
      juniorReviewItems,
      eq(juniorReviewItems.id, juniorReviewItemConversations.itemId),
    )
    .where(reviewItemNeedsUser(userId));
  return rows.map((row) => row.conversationId).sort();
}
