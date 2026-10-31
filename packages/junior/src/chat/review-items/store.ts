import { randomUUID } from "node:crypto";
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { User } from "@sentry/junior-plugin-api";
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

export type ReviewItemKind = "notice" | "action";
export type ReviewItemStatus = "open" | "done" | "dismissed";
export type ReviewItemVisibility = "public" | "private";

/** The thing a Review item is about, such as a pull request. */
export interface ReviewItemSubject {
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
 * Who reads Review items. An item is visible when it is public and its
 * tenant is one of the reader's tenants, when the reader is an assigned
 * User, or when it is linked to the reader's Conversation or added by the
 * reader's Automation.
 */
export interface ReviewItemReader {
  automationId?: string;
  conversationId?: string;
  /** Provider tenants where the reader can see public items. */
  tenants?: readonly ProviderTenant[];
  userId?: string;
}

function assignedTo(userId: string): SQL {
  return sql`exists (select 1 from ${juniorReviewItemAssignees} where ${juniorReviewItemAssignees.itemId} = ${juniorReviewItems.id} and ${juniorReviewItemAssignees.userId} = ${userId})`;
}

function linkedTo(conversationId: string): SQL {
  return sql`exists (select 1 from ${juniorReviewItemConversations} where ${juniorReviewItemConversations.itemId} = ${juniorReviewItems.id} and ${juniorReviewItemConversations.conversationId} = ${conversationId})`;
}

/**
 * The reader for one person: items assigned to them, and public items in the
 * provider tenants of their identities.
 */
export function reviewItemReaderForUser(user: User): ReviewItemReader {
  return {
    tenants: user.identities.flatMap((identity) =>
      identity.providerTenantId
        ? [
            {
              provider: identity.provider,
              providerTenantId: identity.providerTenantId,
            },
          ]
        : [],
    ),
    userId: user.id,
  };
}

/** Return whether two tenants are the same. Two missing tenants match. */
export function isSameTenant(
  a: ProviderTenant | undefined,
  b: ProviderTenant | undefined,
): boolean {
  return (
    a?.provider === b?.provider && a?.providerTenantId === b?.providerTenantId
  );
}

function publicIn(tenants: readonly ProviderTenant[]): SQL[] {
  return tenants.map(
    (tenant) =>
      and(
        eq(juniorReviewItems.visibility, "public"),
        eq(juniorReviewItems.provider, tenant.provider),
        eq(juniorReviewItems.providerTenantId, tenant.providerTenantId),
      )!,
  );
}

function visibleTo(reader: ReviewItemReader): SQL {
  // `or` of nothing is undefined, so `false` keeps the query closed.
  return or(
    sql`false`,
    ...publicIn(reader.tenants ?? []),
    ...(reader.userId ? [assignedTo(reader.userId)] : []),
    ...(reader.conversationId ? [linkedTo(reader.conversationId)] : []),
    ...(reader.automationId
      ? [eq(juniorReviewItems.automationId, reader.automationId)]
      : []),
  )!;
}

/** Return whether a reader can see one Review item. */
export function canReadReviewItem(
  item: ReviewItem,
  reader: ReviewItemReader,
): boolean {
  return (
    (item.visibility === "public" &&
      item.tenant !== undefined &&
      (reader.tenants ?? []).some((tenant) =>
        isSameTenant(tenant, item.tenant),
      )) ||
    (reader.userId !== undefined &&
      item.assignees.some((assignee) => assignee.userId === reader.userId)) ||
    (reader.conversationId !== undefined &&
      item.conversationIds.includes(reader.conversationId)) ||
    (reader.automationId !== undefined &&
      item.automationId === reader.automationId)
  );
}

/** Filters for Review item search. Every filter is optional. */
export interface ReviewItemFilters {
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
    visibleTo(reader),
    inArray(juniorReviewItems.status, [...filters.statuses]),
  ];
  if (filters.subjectId) {
    conditions.push(eq(juniorReviewItems.subjectId, filters.subjectId));
  }
  if (filters.automationId) {
    conditions.push(eq(juniorReviewItems.automationId, filters.automationId));
  }
  if (filters.conversationId) {
    conditions.push(linkedTo(filters.conversationId));
  }
  if (filters.assignee) {
    conditions.push(
      "everyone" in filters.assignee
        ? eq(juniorReviewItems.assignedToEveryone, true)
        : assignedTo(filters.assignee.userId),
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

/** Count the Review items that a reader can see and that match filters. */
export async function countReviewItems(
  db: JuniorDatabase,
  reader: ReviewItemReader,
  filters: Omit<ReviewItemFilters, "limit">,
): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(juniorReviewItems)
    .where(and(...searchConditions(reader, filters)));
  return rows[0]?.count ?? 0;
}

/** Find the Review items that a reader can see, newest change first. */
export async function searchReviewItems(
  db: JuniorDatabase,
  reader: ReviewItemReader,
  filters: ReviewItemFilters,
): Promise<ReviewItem[]> {
  const rows = await db
    .select()
    .from(juniorReviewItems)
    .where(and(...searchConditions(reader, filters)))
    .orderBy(desc(juniorReviewItems.updatedAt), desc(juniorReviewItems.id))
    .limit(filters.limit);
  return await hydrate(db, rows);
}

/**
 * List the Conversations that wait on a User: each has an open linked item
 * that the User can see and that is assigned to the User or to Everyone. An
 * item without assignees does not wait on anyone.
 */
export async function listWaitingConversationIds(
  db: JuniorDatabase,
  user: User,
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
    .where(
      and(
        eq(juniorReviewItems.status, "open"),
        visibleTo(reviewItemReaderForUser(user)),
        or(eq(juniorReviewItems.assignedToEveryone, true), assignedTo(user.id)),
      ),
    );
  return rows.map((row) => row.conversationId).sort();
}
