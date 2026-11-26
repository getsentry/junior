import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  lt,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ProviderTenant } from "@/api/conversations/access";
import { touchConversationDetail } from "@/chat/conversations/sql/detail-version";
import { inboxItemSnoozedBy } from "@/chat/inbox-snoozes/store";
import type { JuniorDatabase } from "@/db/db";
import {
  inboxItemOwnerConversationId,
  inboxItemOwnerId,
  inboxItemOwnerKind,
  inboxItemTenantId,
  inboxItemTenantProvider,
  inboxItemVisibility,
} from "@/chat/inbox-items/owner";
import {
  hasUserPhoto,
  userAvatarUrlsFromIdentities,
} from "@/chat/identities/avatar";
import {
  juniorAutomationRuns,
  juniorConversations,
  juniorIdentities,
  juniorInboxItemAssignees,
  juniorInboxItemConversations,
  juniorInboxItems,
  juniorQuestions,
  juniorUsers,
} from "@/db/schema";
import type { UserInputAnswer } from "@/chat/inbox-items/user-input-request";
import {
  inboxItemAddedByAnyAutomation,
  inboxItemAddedByAutomation,
  inboxItemAssignedTo,
  inboxItemForUser,
  inboxItemLinkedTo,
  inboxItemNeedsUser,
  inboxItemOwnedByConversation,
  inboxItemVisibleTo,
  type InboxItemReader,
} from "./access";
import { claimInboxItemPush, clearInboxItemDeliveries } from "./deliveries";
import type { InboxItemNoticeRequest, InboxItemRequest } from "./request";
import {
  inboxItemBody,
  inboxItemTitle,
  itemQuestion,
} from "./question-content";
import { INBOX_SUBJECT_KINDS, type InboxItemSubject } from "./subjects";

export type { InboxItemSubject } from "./subjects";

type InboxItemKind = "notice" | "action";

/**
 * Close reason of an action item that a person answered with a reply in
 * its thread instead of on the card or the Inbox.
 */
export const INBOX_ITEM_REPLIED_REASON = "Replied in thread";
export type InboxItemStatus = "open" | "done" | "dismissed";
export type InboxItemVisibility = "public" | "private";

/** One assigned User of an Inbox item. */
export interface InboxItemAssignee {
  /** Junior API path of the profile photo. */
  avatarUrl?: string;
  displayName?: string;
  email: string;
  userId: string;
}

/** The kind of an Inbox item's owner. */
type InboxItemOwnerKind = "conversation" | "automation";

/**
 * What an Inbox item belongs to, like a parent: the Conversation of the
 * agent or plugin that added it, or the Automation of an Automation alert.
 * The item's subject names it (`owner.ts`).
 */
export interface InboxItemOwner {
  id: string;
  kind: InboxItemOwnerKind;
}

/** Return the Conversation that owns an item, or undefined for another owner. */
export function ownerConversationId(
  item: Pick<InboxItem, "owner">,
): string | undefined {
  return item.owner.kind === "conversation" ? item.owner.id : undefined;
}

/** The owner Conversations, whose detail versions an item change moves. */
function ownerConversationIds(
  owners: readonly { ownerConversationId: string | null }[],
): string[] {
  return [
    ...new Set(
      owners.flatMap((owner) =>
        owner.ownerConversationId ? [owner.ownerConversationId] : [],
      ),
    ),
  ];
}

// Read in RETURNING, so a change moves the detail version of its owner.
function ownerColumns() {
  return { ownerConversationId: inboxItemOwnerConversationId() };
}

/** An Inbox item with its assignees and linked Conversations. */
export interface InboxItem {
  /** Turn that added the item. Unset for a plugin item. */
  addedByTurnId?: string;
  answer?: UserInputAnswer;
  assignedToEveryone: boolean;
  assignees: InboxItemAssignee[];
  /**
   * The Automation whose run added the item, read from the run of the
   * owner Conversation. Its later runs can read and change the item.
   */
  addedByAutomationId?: string;
  closeReason?: string;
  closedAt?: Date;
  closedBy?: InboxItemAssignee;
  conversationIds: string[];
  createdAt: Date;
  /**
   * The stored root of the Conversation that owns the item. Only a search
   * sets it; unset means unknown, and null means none, such as for an
   * Automation owner.
   */
  ownerRootConversationId?: string | null;
  id: string;
  kind: InboxItemKind;
  owner: InboxItemOwner;
  request?: InboxItemRequest | InboxItemNoticeRequest;
  status: InboxItemStatus;
  subject: InboxItemSubject;
  /** Provider tenant of the item's owner. */
  tenant?: ProviderTenant;
  title: string;
  body: string;
  updatedAt: Date;
  /** Live from the Destination of the item's owner. */
  visibility: InboxItemVisibility;
}

/** The fields an agent sets when it adds or changes an Inbox item. */
export interface InboxItemContent {
  assignedToEveryone: boolean;
  assigneeUserIds: string[];
  body: string;
  conversationIds: string[];
  kind: InboxItemKind;
  request?: InboxItemRequest | InboxItemNoticeRequest;
  subject: InboxItemSubject;
  title: string;
}

/**
 * One stored item, with the Automation whose run owns it, and the question
 * of a question item. The run of the owner Conversation names that
 * Automation, so the item stores no copy.
 */
interface ItemRow {
  addedByAutomationId: string | null;
  item: typeof juniorInboxItems.$inferSelect;
  owner: {
    id: string | null;
    kind: InboxItemOwnerKind;
    tenantId: string | null;
    tenantProvider: string | null;
    visibility: InboxItemVisibility;
  };
  question: typeof juniorQuestions.$inferSelect | null;
}

// The fields of an item row (`ItemRow`).
function itemRowFields() {
  return {
    addedByAutomationId: juniorAutomationRuns.automationId,
    item: juniorInboxItems,
    owner: {
      id: inboxItemOwnerId(),
      kind: inboxItemOwnerKind(),
      tenantId: inboxItemTenantId(),
      tenantProvider: inboxItemTenantProvider(),
      visibility: inboxItemVisibility(),
    },
    question: juniorQuestions,
  };
}

/** The join that reads the Automation of an item's owner run. */
function ownerRun(): SQL {
  return eq(
    juniorAutomationRuns.conversationId,
    inboxItemOwnerConversationId(),
  );
}

/**
 * Select item rows with their owner, the Automation of their owner run, and
 * the question of a question item.
 */
function selectItemRows(db: JuniorDatabase) {
  return db
    .select(itemRowFields())
    .from(juniorInboxItems)
    .leftJoin(juniorAutomationRuns, ownerRun())
    .leftJoin(juniorQuestions, itemQuestion);
}

const userPhotos = alias(juniorIdentities, "inbox_item_user_photos");

async function readUsers(
  db: JuniorDatabase,
  userIds: readonly string[],
): Promise<Map<string, InboxItemAssignee>> {
  if (userIds.length === 0) return new Map();
  // One read returns each User with their photo Identities.
  const rows = await db
    .select({
      displayName: juniorUsers.displayName,
      email: juniorUsers.primaryEmail,
      photo: {
        avatarUrl: userPhotos.avatarUrl,
        identityId: userPhotos.id,
        provider: userPhotos.provider,
        updatedAt: userPhotos.updatedAt,
      },
      userId: juniorUsers.id,
    })
    .from(juniorUsers)
    .leftJoin(
      userPhotos,
      and(eq(userPhotos.userId, juniorUsers.id), hasUserPhoto(userPhotos)),
    )
    .where(inArray(juniorUsers.id, [...new Set(userIds)]));
  const avatars = userAvatarUrlsFromIdentities(
    rows.flatMap(({ photo, userId }) =>
      photo?.identityId && photo.provider && photo.updatedAt
        ? [{ ...photo, identityId: photo.identityId, userId }]
        : [],
    ),
  );
  const users = new Map<string, InboxItemAssignee>();
  for (const row of rows) {
    if (users.has(row.userId)) continue;
    const avatarUrl = avatars.get(row.userId);
    users.set(row.userId, {
      email: row.email,
      userId: row.userId,
      ...(avatarUrl ? { avatarUrl } : undefined),
      ...(row.displayName ? { displayName: row.displayName } : undefined),
    });
  }
  return users;
}

async function hydrate(
  db: JuniorDatabase,
  itemRows: readonly ItemRow[],
): Promise<InboxItem[]> {
  // An item whose owner row is gone, such as a purged Conversation's, has
  // nobody to show it to.
  const owned = itemRows.filter((row) => row.owner.id !== null);
  if (owned.length === 0) return [];
  const rows = owned.map((row) => row.item);
  const ids = rows.map((row) => row.id);
  const [assigneeRows, conversationRows] = await Promise.all([
    db
      .select()
      .from(juniorInboxItemAssignees)
      .where(inArray(juniorInboxItemAssignees.itemId, ids)),
    db
      .select()
      .from(juniorInboxItemConversations)
      .where(inArray(juniorInboxItemConversations.itemId, ids)),
  ]);
  const users = await readUsers(db, [
    ...assigneeRows.map((row) => row.userId),
    ...rows.flatMap((row) => (row.closedByUserId ? [row.closedByUserId] : [])),
  ]);
  return rows.map((row, index) => {
    const { addedByAutomationId, owner, question } = owned[index]!;
    // A question item's content is its question's.
    const content = question ?? row;
    const closedBy = row.closedByUserId
      ? users.get(row.closedByUserId)
      : undefined;
    return {
      assignedToEveryone: row.assignedToEveryone,
      assignees: assigneeRows
        .filter((assignee) => assignee.itemId === row.id)
        .flatMap((assignee) => users.get(assignee.userId) ?? [])
        .sort((a, b) => a.email.localeCompare(b.email)),
      body: content.body ?? "",
      conversationIds: conversationRows
        .filter((link) => link.itemId === row.id)
        .map((link) => link.conversationId)
        .sort(),
      createdAt: row.createdAt,
      id: row.id,
      kind: row.kind,
      owner: { id: owner.id!, kind: owner.kind },
      status: row.status,
      subject: { id: row.subjectId, kind: row.subjectKind },
      title: content.title ?? "",
      updatedAt: row.updatedAt,
      visibility: owner.visibility,
      ...(content.answer ? { answer: content.answer } : undefined),
      ...(row.addedByTurnId ? { addedByTurnId: row.addedByTurnId } : undefined),
      ...(addedByAutomationId ? { addedByAutomationId } : undefined),
      ...(row.closeReason ? { closeReason: row.closeReason } : undefined),
      ...(row.closedAt ? { closedAt: row.closedAt } : undefined),
      ...(closedBy ? { closedBy } : undefined),
      ...(content.request ? { request: content.request } : undefined),
      ...(owner.tenantProvider && owner.tenantId
        ? {
            tenant: {
              provider: owner.tenantProvider,
              providerTenantId: owner.tenantId,
            },
          }
        : undefined),
    };
  });
}

function isQuestion(subject: InboxItemSubject): boolean {
  return subject.kind === INBOX_SUBJECT_KINDS.question;
}

// A question item stores no content: its question holds it.
function contentColumns(content: InboxItemContent) {
  const own = !isQuestion(content.subject);
  return {
    assignedToEveryone: content.assignedToEveryone,
    body: own ? content.body : null,
    kind: content.kind,
    request: own ? (content.request ?? null) : null,
    subjectId: content.subject.id,
    subjectKind: content.subject.kind,
    title: own ? content.title : null,
  };
}

function questionColumns(content: InboxItemContent) {
  return {
    body: content.body,
    request: content.request ?? null,
    title: content.title,
  };
}

async function replaceLinks(
  db: JuniorDatabase,
  itemId: string,
  content: Pick<InboxItemContent, "assigneeUserIds" | "conversationIds">,
): Promise<void> {
  await db
    .delete(juniorInboxItemAssignees)
    .where(eq(juniorInboxItemAssignees.itemId, itemId));
  await db
    .delete(juniorInboxItemConversations)
    .where(eq(juniorInboxItemConversations.itemId, itemId));
  const userIds = [...new Set(content.assigneeUserIds)];
  if (userIds.length > 0) {
    await db
      .insert(juniorInboxItemAssignees)
      .values(userIds.map((userId) => ({ itemId, userId })));
  }
  const conversationIds = [...new Set(content.conversationIds)];
  if (conversationIds.length > 0) {
    await db
      .insert(juniorInboxItemConversations)
      .values(
        conversationIds.map((conversationId) => ({ itemId, conversationId })),
      );
  }
}

/** Read one Inbox item by id. */
export async function getInboxItem(
  db: JuniorDatabase,
  id: string,
): Promise<InboxItem | undefined> {
  const rows = await selectItemRows(db).where(eq(juniorInboxItems.id, id));
  return (await hydrate(db, rows))[0];
}

/** Return whether one Inbox item is open. */
export async function isInboxItemOpen(
  db: JuniorDatabase,
  id: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: juniorInboxItems.id })
    .from(juniorInboxItems)
    .where(
      and(eq(juniorInboxItems.id, id), eq(juniorInboxItems.status, "open")),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Read the action items that the agent added in one Conversation and that a
 * reply can answer: the open items, and the items that a reply closed. A
 * plugin's items are left out: the plugin closes them when its provider
 * state changes, such as when a pull request merges. A To-do's items are
 * left out too: they close when the To-do does.
 */
export async function listReplyActionItems(
  db: JuniorDatabase,
  conversationId: string,
): Promise<InboxItem[]> {
  const rows = await selectItemRows(db).where(
    and(
      inboxItemOwnedByConversation(conversationId),
      eq(juniorInboxItems.kind, "action"),
      eq(juniorInboxItems.subjectKind, INBOX_SUBJECT_KINDS.question),
      or(
        eq(juniorInboxItems.status, "open"),
        eq(juniorInboxItems.closeReason, INBOX_ITEM_REPLIED_REASON),
      ),
    ),
  );
  return await hydrate(db, rows);
}

/**
 * Read the open Inbox item of one subject, if there is one. The subject
 * names at most one open item.
 */
export async function getOpenInboxItemBySubject(
  db: JuniorDatabase,
  subject: InboxItemSubject,
): Promise<InboxItem | undefined> {
  const rows = await selectItemRows(db).where(
    and(
      eq(juniorInboxItems.subjectKind, subject.kind),
      eq(juniorInboxItems.subjectId, subject.id),
      eq(juniorInboxItems.status, "open"),
    ),
  );
  return (await hydrate(db, rows))[0];
}

/**
 * Add one open Inbox item. Return undefined when another open item already
 * has its subject. `owner` is the owner that the subject names: a question
 * stores it as the Conversation that asked.
 */
export async function insertInboxItem(
  db: JuniorDatabase,
  input: InboxItemContent & {
    addedByTurnId?: string;
    nowMs: number;
    owner: InboxItemOwner;
  },
): Promise<InboxItem | undefined> {
  const now = new Date(input.nowMs);
  const id = await db.transaction(async (tx) => {
    if (isQuestion(input.subject)) {
      if (input.owner.kind !== "conversation") {
        throw new Error("Only a Conversation asks a question");
      }
      // A concurrent add of the same question adds it first.
      const asked = await tx
        .insert(juniorQuestions)
        .values({
          ...questionColumns(input),
          conversationId: input.owner.id,
          createdAt: now,
          id: input.subject.id,
          turnId: input.addedByTurnId ?? null,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: juniorQuestions.id });
      if (!asked[0]) return undefined;
    }
    // The old owner columns stay for the release before this one, and a
    // trigger writes them from this owner (migration
    // `20261126034025_inbox_item_owners`). A later release drops both.
    await tx.execute(
      sql`select set_config('junior.inbox_item_owner_kind', ${input.owner.kind}, true), set_config('junior.inbox_item_owner_id', ${input.owner.id}, true)`,
    );
    const inserted = await tx
      .insert(juniorInboxItems)
      .values({
        ...contentColumns(input),
        addedByTurnId: input.addedByTurnId ?? null,
        createdAt: now,
        id: randomUUID(),
        status: "open",
        updatedAt: now,
      })
      // The only possible conflict is the open subject index.
      .onConflictDoNothing()
      .returning({ id: juniorInboxItems.id });
    if (!inserted[0]) return undefined;
    // The subject names the owner. An item whose subject names another
    // owner, or none, such as a plugin subject with no owner row, would
    // show to the wrong people or to nobody.
    const [owned] = await tx
      .select({ ownerId: inboxItemOwnerId() })
      .from(juniorInboxItems)
      .where(eq(juniorInboxItems.id, inserted[0].id));
    if (owned?.ownerId !== input.owner.id) {
      throw new Error(
        `Inbox item subject ${input.subject.kind}:${input.subject.id} does not belong to ${input.owner.kind} ${input.owner.id}`,
      );
    }
    await replaceLinks(tx, inserted[0].id, input);
    if (input.owner.kind === "conversation") {
      await touchConversationDetail(tx, [input.owner.id]);
    }
    return inserted[0].id;
  });
  if (!id) return undefined;
  const item = await getInboxItem(db, id);
  if (!item) throw new Error(`Inbox item ${id} is missing after insert`);
  return item;
}

/**
 * Replace the content of one open Inbox item. Return false when closed.
 * `addedByTurnId` moves the Turn pointer to the Turn that added the item
 * again; omit it to keep the stored Turn.
 */
export async function updateInboxItemContent(
  db: JuniorDatabase,
  input: InboxItemContent & {
    addedByTurnId?: string;
    id: string;
    nowMs: number;
  },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    // Lock the open item first, so a close cannot land between the
    // question write and the item write. A close locks in the same order.
    const open = await tx
      .select({ id: juniorInboxItems.id })
      .from(juniorInboxItems)
      .where(
        and(
          eq(juniorInboxItems.id, input.id),
          eq(juniorInboxItems.status, "open"),
        ),
      )
      .for("update");
    if (!open[0]) return false;
    // The question changes first: the item write copies its content onto
    // the item for the release before this one (`20261126034025_inbox_item_owners`).
    if (isQuestion(input.subject)) {
      await tx
        .update(juniorQuestions)
        .set({
          ...questionColumns(input),
          updatedAt: new Date(input.nowMs),
          ...(input.addedByTurnId
            ? { turnId: input.addedByTurnId }
            : undefined),
        })
        .where(eq(juniorQuestions.id, input.subject.id));
    }
    const updated = await tx
      .update(juniorInboxItems)
      .set({
        ...contentColumns(input),
        updatedAt: new Date(input.nowMs),
        ...(input.addedByTurnId
          ? { addedByTurnId: input.addedByTurnId }
          : undefined),
      })
      .where(
        and(
          eq(juniorInboxItems.id, input.id),
          eq(juniorInboxItems.status, "open"),
        ),
      )
      .returning({ ...ownerColumns(), id: juniorInboxItems.id });
    if (!updated[0]) return false;
    await replaceLinks(tx, updated[0].id, input);
    await touchConversationDetail(tx, ownerConversationIds(updated));
    return true;
  });
}

/**
 * Close one open Inbox item. `closedByUserId` is the person who closed it,
 * and it is unset when an agent closes it. Return false when the item was
 * already closed, so only the first close wins.
 */
export async function closeInboxItem(
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
  const updated = await db.transaction(async (tx) => {
    const closed = await tx
      .update(juniorInboxItems)
      .set({
        // A question item's answer goes to its question. The item keeps a
        // copy, because the release before this one reads it there.
        answer: input.answer ?? null,
        closeReason: input.reason ?? null,
        closedAt: now,
        closedByUserId: input.closedByUserId ?? null,
        status: input.status,
        updatedAt: now,
      })
      .where(
        and(
          eq(juniorInboxItems.id, input.id),
          eq(juniorInboxItems.status, "open"),
        ),
      )
      .returning({
        ...ownerColumns(),
        subjectId: juniorInboxItems.subjectId,
        subjectKind: juniorInboxItems.subjectKind,
      });
    const item = closed[0];
    if (input.answer && item?.subjectKind === INBOX_SUBJECT_KINDS.question) {
      await tx
        .update(juniorQuestions)
        .set({ answer: input.answer, updatedAt: now })
        .where(eq(juniorQuestions.id, item.subjectId));
    }
    await touchConversationDetail(tx, ownerConversationIds(closed));
    return closed;
  });
  if (updated.length === 0) return false;
  await clearInboxItemDeliveries(db, [input.id], input.nowMs);
  return true;
}

/**
 * Dismiss open Inbox items by id, or the ones that an Automation or a set
 * of Conversations added, when no agent can act on them any more. No person
 * closes them. It sends no message and does not change the Slack cards. A
 * close by Conversations skips the items of an Automation, because a later
 * run of the Automation can still change them. An Automation delete closes
 * those.
 */
export async function dismissOpenInboxItems(
  db: JuniorDatabase,
  input: { nowMs: number; reason: string } & (
    | { ownerConversationIds: readonly string[] }
    | { automationId: string }
    | { ids: readonly string[] }
  ),
): Promise<void> {
  if ("ids" in input && input.ids.length === 0) return;
  const now = new Date(input.nowMs);
  const dismissed = await db
    .update(juniorInboxItems)
    .set({
      closeReason: input.reason,
      closedAt: now,
      status: "dismissed",
      updatedAt: now,
    })
    .where(
      and(
        eq(juniorInboxItems.status, "open"),
        "ids" in input
          ? inArray(juniorInboxItems.id, [...input.ids])
          : "automationId" in input
            ? inboxItemAddedByAutomation(input.automationId)
            : and(
                inArray(inboxItemOwnerConversationId(), [
                  ...input.ownerConversationIds,
                ]),
                not(inboxItemAddedByAnyAutomation()),
              ),
      ),
    )
    .returning({ ...ownerColumns(), id: juniorInboxItems.id });
  await clearInboxItemDeliveries(
    db,
    dismissed.map((item) => item.id),
    input.nowMs,
  );
  await touchConversationDetail(db, ownerConversationIds(dismissed));
}

/**
 * Make one User the only assignee of an open Inbox item. Return false when
 * the item is closed.
 */
export async function takeInboxItem(
  db: JuniorDatabase,
  input: { id: string; nowMs: number; userId: string },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const updated = await tx
      .update(juniorInboxItems)
      .set({ assignedToEveryone: false, updatedAt: new Date(input.nowMs) })
      .where(
        and(
          eq(juniorInboxItems.id, input.id),
          eq(juniorInboxItems.status, "open"),
        ),
      )
      .returning(ownerColumns());
    if (!updated[0]) return false;
    await tx
      .delete(juniorInboxItemAssignees)
      .where(eq(juniorInboxItemAssignees.itemId, input.id));
    await tx
      .insert(juniorInboxItemAssignees)
      .values({ itemId: input.id, userId: input.userId });
    // The taker is now an assignee, but needs no push for their own take.
    await claimInboxItemPush(tx, {
      itemId: input.id,
      nowMs: input.nowMs,
      skipReason: "taken",
      userId: input.userId,
    });
    await touchConversationDetail(tx, ownerConversationIds(updated));
    return true;
  });
}

/**
 * A position in the oldest-first order: the last item of a page. Search
 * returns the items after it.
 */
export interface InboxItemPosition {
  createdAt: Date;
  id: string;
}

/**
 * A position in the waiting-first order: the last item of a page, and
 * whether it needs the User. Search returns the items after it.
 */
export interface InboxItemWaitingPosition extends InboxItemPosition {
  needsUser: boolean;
}

/**
 * A position in the newest-closed-first order: the last closed item of a
 * page. Search returns the items closed before it.
 */
export interface InboxItemClosedPosition {
  closedAt: Date;
  id: string;
}

/** Filters for Inbox item search. Every filter is optional. */
export interface InboxItemFilters {
  /**
   * Return only the items after this position. Use it with `order: "oldest"`
   * and one status group, such as only open items, because open items sort
   * first.
   */
  after?: InboxItemPosition;
  /**
   * Return only the items after this position. Use it with
   * `order: { needsUserId }` and only open items.
   */
  afterWaiting?: InboxItemWaitingPosition;
  /** One assigned User, or Everyone. */
  assignee?: { everyone: true } | { userId: string };
  automationId?: string;
  /**
   * Return only the items closed before this position. Use it with
   * `order: "closed"` and closed statuses.
   */
  closedBefore?: InboxItemClosedPosition;
  conversationId?: string;
  /**
   * Drop the items that are assigned only to other people
   * (`inboxItemForUser`).
   */
  forUserId?: string;
  /** Keep only the items that this kind of owner owns. */
  ownerKind?: InboxItemOwnerKind;
  /** Drop the items in Inbox rows that this User snoozed. */
  awakeForUserId?: string;
  /** Keep only the items in Inbox rows that this User snoozed. */
  snoozedForUserId?: string;
  limit: number;
  /** Words to find in the title or body. */
  query?: string;
  /**
   * `oldest` sorts by creation, oldest first. `closed` sorts closed items by
   * when they closed, newest first. `{ needsUserId }` puts the items that
   * need that User first (`inboxItemNeedsUser`), then the rest, each group
   * newest created first. By default the newest change comes first.
   */
  order?: "closed" | "oldest" | { needsUserId: string };
  statuses: readonly InboxItemStatus[];
  subjectId?: string;
}

function searchConditions(
  reader: InboxItemReader,
  filters: Omit<InboxItemFilters, "limit">,
): SQL[] {
  const conditions: SQL[] = [
    inboxItemVisibleTo(reader),
    inArray(juniorInboxItems.status, [...filters.statuses]),
  ];
  if (filters.after) {
    conditions.push(
      or(
        gt(juniorInboxItems.createdAt, filters.after.createdAt),
        and(
          eq(juniorInboxItems.createdAt, filters.after.createdAt),
          gt(juniorInboxItems.id, filters.after.id),
        ),
      )!,
    );
  }
  if (filters.afterWaiting) {
    if (typeof filters.order !== "object") {
      throw new Error("afterWaiting needs the waiting-first order");
    }
    const needs = inboxItemNeedsUser(filters.order.needsUserId);
    const { createdAt, id, needsUser } = filters.afterWaiting;
    const older = or(
      lt(juniorInboxItems.createdAt, createdAt),
      and(
        eq(juniorInboxItems.createdAt, createdAt),
        lt(juniorInboxItems.id, id),
      ),
    )!;
    conditions.push(
      needsUser ? or(not(needs), and(needs, older))! : and(not(needs), older)!,
    );
  }
  if (filters.closedBefore) {
    conditions.push(
      or(
        lt(juniorInboxItems.closedAt, filters.closedBefore.closedAt),
        and(
          eq(juniorInboxItems.closedAt, filters.closedBefore.closedAt),
          lt(juniorInboxItems.id, filters.closedBefore.id),
        ),
      )!,
    );
  }
  if (filters.subjectId) {
    conditions.push(eq(juniorInboxItems.subjectId, filters.subjectId));
  }
  if (filters.automationId) {
    conditions.push(inboxItemAddedByAutomation(filters.automationId));
  }
  if (filters.conversationId) {
    conditions.push(inboxItemLinkedTo(filters.conversationId));
  }
  if (filters.assignee) {
    conditions.push(
      "everyone" in filters.assignee
        ? eq(juniorInboxItems.assignedToEveryone, true)
        : inboxItemAssignedTo(filters.assignee.userId),
    );
  }
  if (filters.ownerKind) {
    conditions.push(eq(inboxItemOwnerKind(), filters.ownerKind));
  }
  if (filters.forUserId) {
    conditions.push(inboxItemForUser(filters.forUserId));
  }
  if (filters.awakeForUserId) {
    conditions.push(not(inboxItemSnoozedBy(filters.awakeForUserId)));
  }
  if (filters.snoozedForUserId) {
    conditions.push(inboxItemSnoozedBy(filters.snoozedForUserId));
  }
  if (filters.query) {
    const pattern = `%${filters.query.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(
      or(ilike(inboxItemTitle, pattern), ilike(inboxItemBody, pattern))!,
    );
  }
  return conditions;
}

/**
 * Find the Inbox items that a reader can see. Open items come first, so
 * the limit never drops an open item for a closed one. Then the newest
 * change comes first: `updated_at`, then `id`, both descending. With
 * `order: "oldest"`, the oldest item comes first: `created_at`, then `id`,
 * both ascending. `after` pages through that order. With `order: "closed"`,
 * the item closed last comes first: `closed_at`, then `id`, both
 * descending. `closedBefore` pages through that order. With
 * `order: { needsUserId }`, the items that need the User come first, then
 * `created_at` and `id`, both descending. `afterWaiting` pages through it.
 */
export async function searchInboxItems(
  db: JuniorDatabase,
  reader: InboxItemReader,
  filters: InboxItemFilters,
): Promise<InboxItem[]> {
  const rows = await db
    .select({
      ...itemRowFields(),
      ownerRootConversationId: juniorConversations.rootConversationId,
    })
    .from(juniorInboxItems)
    .leftJoin(
      juniorConversations,
      inboxItemOwnedByConversation(juniorConversations.conversationId),
    )
    .leftJoin(juniorAutomationRuns, ownerRun())
    .leftJoin(juniorQuestions, itemQuestion)
    .where(and(...searchConditions(reader, filters)))
    .orderBy(
      desc(eq(juniorInboxItems.status, "open")),
      ...(typeof filters.order === "object"
        ? [
            desc(inboxItemNeedsUser(filters.order.needsUserId)),
            desc(juniorInboxItems.createdAt),
            desc(juniorInboxItems.id),
          ]
        : filters.order === "oldest"
          ? [asc(juniorInboxItems.createdAt), asc(juniorInboxItems.id)]
          : filters.order === "closed"
            ? [desc(juniorInboxItems.closedAt), desc(juniorInboxItems.id)]
            : [desc(juniorInboxItems.updatedAt), desc(juniorInboxItems.id)]),
    )
    .limit(filters.limit);
  const roots = new Map(
    rows.map((row) => [row.item.id, row.ownerRootConversationId]),
  );
  return (await hydrate(db, rows)).map((item) => ({
    ...item,
    ownerRootConversationId: roots.get(item.id) ?? null,
  }));
}
