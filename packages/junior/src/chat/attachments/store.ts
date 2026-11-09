import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorAttachments, juniorConversations } from "@/db/schema";
import type { SandboxFileUpload } from "@/chat/tools/sandbox/file-uploads";
import { touchConversationDetail } from "@/chat/conversations/sql/detail-version";
import type { AttachmentStorage } from "./storage";

const DAY_MS = 24 * 60 * 60 * 1000;
const ATTACHMENT_GC_BATCH_LIMIT = 200;

/** Time that Junior keeps attachment bytes after the file is stored. */
export const ATTACHMENT_RETENTION_MS = 30 * DAY_MS;

export interface StoredAttachment {
  id: string;
}

/** Live conversation-owned attachment metadata. */
export interface AttachmentRecord {
  bytes: number;
  contentType: string;
  conversationId: string;
  filename: string;
  id: string;
  storageKey: string;
  storageProvider: string;
}

type AttachmentRow = Pick<
  typeof juniorAttachments.$inferSelect,
  | "contentType"
  | "conversationId"
  | "expiresAt"
  | "filename"
  | "id"
  | "provider"
  | "providerId"
  | "sha256"
  | "status"
  | "storageKey"
  | "storageProvider"
>;

export interface AttachmentGarbageCollectionResult {
  deleted: number;
}

function attachmentDigest(file: SandboxFileUpload): string {
  return createHash("sha256").update(file.data).digest("hex");
}

/** Stable conversation-owned id for one file body and presentation metadata. */
function attachmentId(args: {
  conversationId: string;
  contentType: string;
  filename: string;
  source?: { id: string; provider: string };
  storageProvider: string;
  sha256: string;
}): string {
  const identity = [
    args.conversationId,
    args.storageProvider,
    args.sha256,
    args.filename,
    args.contentType,
  ];
  if (args.source) {
    identity.push(args.source.provider, args.source.id);
  }
  return createHash("sha256").update(identity.join("\0")).digest("hex");
}

/**
 * Object key for one write attempt.
 *
 * Attachment ids are content-stable. Object keys are not: each put gets a fresh
 * key so a failed-write cleanup or GC delete cannot remove another writer's
 * durable blob.
 */
function attachmentKey(args: {
  attachmentId: string;
  conversationId: string;
  filename: string;
  writeId: string;
}): string {
  return `conversations/${args.conversationId}/attachments/${args.attachmentId}/${args.writeId}/${args.filename}`;
}

async function bestEffortDelete(
  storage: AttachmentStorage,
  key: string,
): Promise<void> {
  try {
    await storage.delete([key]);
  } catch {
    // Leave the blob. Unique keys make a later store write a different object.
  }
}

/** SQL filter for rows whose bytes Junior may read at `now`. */
export function readableAttachment(now: Date): SQL {
  return and(
    eq(juniorAttachments.status, "live"),
    gt(juniorAttachments.expiresAt, now),
  )!;
}

function isReadable(row: AttachmentRow, now: Date): boolean {
  return row.status === "live" && row.expiresAt > now;
}

type AttachmentTransition =
  | { status: "live"; storageKey: string }
  | { status: "delete_requested" }
  | { status: "collected" };

/**
 * Move the rows that `where` matches to a new lifecycle state.
 *
 * A row is inserted `live`. After that, only this function changes its status.
 * Each transition checks the state that it leaves in the same statement, so a
 * late writer cannot undo a newer transition:
 * - `live`: from `delete_requested` or expired `live`, with new bytes. The
 *   30-day retention starts again because the bytes are new.
 * - `delete_requested`: from `live`.
 * - `collected`: from `delete_requested`, after GC deleted the bytes. This
 *   deletes the row.
 *
 * A caller that acts on bytes it read matches on `storageKey`, so that the
 * transition applies only to those bytes.
 */
async function transitionAttachments(args: {
  db: JuniorSqlDatabase;
  now: Date;
  to: AttachmentTransition;
  where: SQL;
}): Promise<Array<{ conversationId: string; storageKey: string }>> {
  const db = args.db.db();
  const returning = {
    conversationId: juniorAttachments.conversationId,
    storageKey: juniorAttachments.storageKey,
  };
  let moved: Array<{ conversationId: string; storageKey: string }>;
  if (args.to.status === "collected") {
    moved = await db
      .delete(juniorAttachments)
      .where(and(args.where, eq(juniorAttachments.status, "delete_requested")))
      .returning(returning);
  } else if (args.to.status === "live") {
    moved = await db
      .update(juniorAttachments)
      .set({
        status: "live",
        storageKey: args.to.storageKey,
        expiresAt: new Date(args.now.getTime() + ATTACHMENT_RETENTION_MS),
        deleteRequestedAt: null,
      })
      .where(
        and(
          args.where,
          or(
            eq(juniorAttachments.status, "delete_requested"),
            lte(juniorAttachments.expiresAt, args.now),
          ),
        ),
      )
      .returning(returning);
  } else {
    moved = await db
      .update(juniorAttachments)
      .set({ status: "delete_requested", deleteRequestedAt: args.now })
      .where(and(args.where, eq(juniorAttachments.status, "live")))
      .returning(returning);
  }
  await touchConversationDetail(db, [
    ...new Set(moved.map((row) => row.conversationId)),
  ]);
  return moved;
}

async function readAttachmentRow(
  db: JuniorSqlDatabase,
  id: string,
): Promise<AttachmentRow | undefined> {
  const [row] = await db
    .db()
    .select({
      contentType: juniorAttachments.contentType,
      conversationId: juniorAttachments.conversationId,
      expiresAt: juniorAttachments.expiresAt,
      filename: juniorAttachments.filename,
      id: juniorAttachments.id,
      provider: juniorAttachments.provider,
      providerId: juniorAttachments.providerId,
      sha256: juniorAttachments.sha256,
      status: juniorAttachments.status,
      storageKey: juniorAttachments.storageKey,
      storageProvider: juniorAttachments.storageProvider,
    })
    .from(juniorAttachments)
    .where(eq(juniorAttachments.id, id));
  return row;
}

async function isConversationPurged(
  db: JuniorSqlDatabase,
  conversationId: string,
): Promise<boolean> {
  const [row] = await db
    .db()
    .select({
      transcriptPurgedAt: juniorConversations.transcriptPurgedAt,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId));
  return row?.transcriptPurgedAt != null;
}

function purgedConversationError(conversationId: string): Error {
  return new Error(
    `Cannot store attachment for purged conversation ${conversationId}`,
  );
}

async function assertConversationNotPurged(
  db: JuniorSqlDatabase,
  conversationId: string,
): Promise<void> {
  if (await isConversationPurged(db, conversationId)) {
    throw purgedConversationError(conversationId);
  }
}

/**
 * Reject a committed write when purge won the race. Mark the row for deletion
 * and drop the object that this write added.
 */
async function rejectWriteIfPurged(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  id: string;
  now: Date;
  storage: AttachmentStorage;
  storageKey: string;
}): Promise<void> {
  if (!(await isConversationPurged(args.db, args.conversationId))) return;
  await transitionAttachments({
    db: args.db,
    now: args.now,
    to: { status: "delete_requested" },
    where: and(
      eq(juniorAttachments.id, args.id),
      eq(juniorAttachments.storageKey, args.storageKey),
    )!,
  });
  await bestEffortDelete(args.storage, args.storageKey);
  throw purgedConversationError(args.conversationId);
}

/**
 * Return another writer's readable row only when the conversation is still
 * active.
 *
 * The caller already wrote a unique object for this attempt. Delete that unused
 * object either way. If the conversation is purged, do not report success for a
 * row that purge/GC is about to remove.
 */
async function reuseLiveAttachment(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  id: string;
  storage: AttachmentStorage;
  storageKey: string;
}): Promise<StoredAttachment> {
  await bestEffortDelete(args.storage, args.storageKey);
  await assertConversationNotPurged(args.db, args.conversationId);
  return { id: args.id };
}

/** Writers that race on one attachment id settle within this many reads. */
const STORE_ATTEMPTS = 3;

/**
 * Persist one conversation-owned file.
 *
 * Identity is content-stable under the conversation. A readable row is reused
 * as is. Otherwise object storage is written first under a unique key, and the
 * SQL row is then created, or moved back to `live` with the new key. A row
 * that is not readable is either waiting for GC or expired, so its bytes are
 * replaced and its retention starts again. If the SQL write fails after object
 * storage accepts the bytes, this path deletes that unique object. A process
 * crash between those steps can leave an unreferenced unique object with no
 * SQL row.
 */
export async function storeAttachment(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  file: SandboxFileUpload;
  nowMs?: number;
  source?: { id: string; provider: string };
  storage: AttachmentStorage;
}): Promise<StoredAttachment> {
  const now = new Date(args.nowMs ?? Date.now());
  const sha256 = attachmentDigest(args.file);
  const id = attachmentId({
    conversationId: args.conversationId,
    contentType: args.file.mimeType,
    filename: args.file.filename,
    source: args.source,
    storageProvider: args.storage.provider,
    sha256,
  });
  let row = await readAttachmentRow(args.db, id);
  if (row) {
    if (
      row.contentType !== args.file.mimeType ||
      row.conversationId !== args.conversationId ||
      row.filename !== args.file.filename ||
      row.provider !== (args.source?.provider ?? null) ||
      row.providerId !== (args.source?.id ?? null) ||
      row.storageProvider !== args.storage.provider ||
      row.sha256 !== sha256
    ) {
      throw new Error(`Attachment write conflicts with ${row.id}`);
    }
    if (isReadable(row, now)) {
      await assertConversationNotPurged(args.db, args.conversationId);
      return { id: row.id };
    }
  }

  await assertConversationNotPurged(args.db, args.conversationId);

  const storageKey = attachmentKey({
    attachmentId: id,
    conversationId: args.conversationId,
    filename: args.file.filename,
    writeId: randomUUID(),
  });
  await args.storage.put({
    body: args.file.data,
    contentType: args.file.mimeType,
    key: storageKey,
  });
  const written = {
    conversationId: args.conversationId,
    db: args.db,
    id,
    now,
    storage: args.storage,
    storageKey,
  };

  for (let attempt = 0; attempt < STORE_ATTEMPTS; attempt++) {
    if (!row) {
      let inserted: Array<{ id: string }>;
      try {
        inserted = await args.db
          .db()
          .insert(juniorAttachments)
          .values({
            id,
            conversationId: args.conversationId,
            storageProvider: args.storage.provider,
            storageKey,
            provider: args.source?.provider,
            providerId: args.source?.id,
            filename: args.file.filename,
            contentType: args.file.mimeType,
            bytes: args.file.bytes,
            sha256,
            createdAt: now,
            status: "live",
            expiresAt: new Date(now.getTime() + ATTACHMENT_RETENTION_MS),
          })
          .onConflictDoNothing({ target: juniorAttachments.id })
          .returning({ id: juniorAttachments.id });
      } catch (error) {
        // Only clean up when the insert itself failed. Post-insert purge
        // handling must not delete a blob for a row that already committed.
        await bestEffortDelete(args.storage, storageKey);
        throw error;
      }
      if (inserted.length > 0) {
        await touchConversationDetail(args.db.db(), [args.conversationId]);
        await rejectWriteIfPurged(written);
        return { id };
      }
    } else if (isReadable(row, now)) {
      // Another writer owns the readable row. Our unique object is unused.
      return reuseLiveAttachment(written);
    } else {
      if (await isConversationPurged(args.db, args.conversationId)) {
        await bestEffortDelete(args.storage, storageKey);
        throw purgedConversationError(args.conversationId);
      }
      const moved = await transitionAttachments({
        db: args.db,
        now,
        to: { status: "live", storageKey },
        where: and(
          eq(juniorAttachments.id, id),
          eq(juniorAttachments.storageKey, row.storageKey),
        )!,
      });
      if (moved.length > 0) {
        // No row points at the old object now.
        await bestEffortDelete(args.storage, row.storageKey);
        await rejectWriteIfPurged(written);
        return { id };
      }
    }
    row = await readAttachmentRow(args.db, id);
  }

  await bestEffortDelete(args.storage, storageKey);
  throw new Error(`Attachment ${id} kept changing while storing`);
}

/** Load one readable attachment owned by a conversation. */
export async function readLiveAttachment(args: {
  attachmentId: string;
  conversationId: string;
  db: JuniorSqlDatabase;
  nowMs?: number;
}): Promise<AttachmentRecord | null> {
  const [row] = await args.db
    .db()
    .select({
      bytes: juniorAttachments.bytes,
      contentType: juniorAttachments.contentType,
      conversationId: juniorAttachments.conversationId,
      filename: juniorAttachments.filename,
      id: juniorAttachments.id,
      storageProvider: juniorAttachments.storageProvider,
      storageKey: juniorAttachments.storageKey,
    })
    .from(juniorAttachments)
    .where(
      and(
        eq(juniorAttachments.id, args.attachmentId),
        eq(juniorAttachments.conversationId, args.conversationId),
        readableAttachment(new Date(args.nowMs ?? Date.now())),
      ),
    );
  if (!row) return null;
  if (await isConversationPurged(args.db, args.conversationId)) {
    return null;
  }
  return row;
}

/** Persist many conversation-owned files. */
export async function storeAttachments(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  files: SandboxFileUpload[];
  nowMs?: number;
  storage: AttachmentStorage;
}): Promise<StoredAttachment[]> {
  const stored: StoredAttachment[] = [];
  for (const file of args.files) {
    stored.push(
      await storeAttachment({
        conversationId: args.conversationId,
        db: args.db,
        file,
        ...(args.nowMs !== undefined ? { nowMs: args.nowMs } : undefined),
        storage: args.storage,
      }),
    );
  }
  return stored;
}

/** Mark attachments unavailable when their conversation content is purged. */
export async function requestAttachmentDeletion(
  db: JuniorSqlDatabase,
  conversationIds: string[],
  nowMs: number,
): Promise<void> {
  if (conversationIds.length === 0) return;
  await transitionAttachments({
    db,
    now: new Date(nowMs),
    to: { status: "delete_requested" },
    where: inArray(juniorAttachments.conversationId, conversationIds),
  });
}

/**
 * Delete unreadable attachments in one bounded batch.
 *
 * Eligible rows are `delete_requested`, expired, or owned by a conversation
 * whose transcript is already purged. Move each eligible `live` row to
 * `delete_requested` before its bytes are deleted, so no reader gets a live row
 * without bytes. Then delete the object keys, and then the rows that still
 * point at them. A failed blob delete leaves the rows for a later run.
 */
export async function collectAttachmentGarbage(args: {
  db: JuniorSqlDatabase;
  nowMs: number;
  storage: AttachmentStorage;
  limit?: number;
}): Promise<AttachmentGarbageCollectionResult> {
  const now = new Date(args.nowMs);
  const rows = await args.db
    .db()
    .select({
      id: juniorAttachments.id,
      status: juniorAttachments.status,
      storageKey: juniorAttachments.storageKey,
    })
    .from(juniorAttachments)
    .innerJoin(
      juniorConversations,
      eq(juniorAttachments.conversationId, juniorConversations.conversationId),
    )
    .where(
      and(
        eq(juniorAttachments.storageProvider, args.storage.provider),
        or(
          eq(juniorAttachments.status, "delete_requested"),
          lte(juniorAttachments.expiresAt, now),
          isNotNull(juniorConversations.transcriptPurgedAt),
        ),
      ),
    )
    .orderBy(asc(juniorAttachments.expiresAt), asc(juniorAttachments.id))
    .limit(args.limit ?? ATTACHMENT_GC_BATCH_LIMIT);
  if (rows.length === 0) return { deleted: 0 };

  const live = rows.filter((row) => row.status === "live");
  // The selected key pins the selected bytes. A row that a writer moved to
  // new bytes since the select does not match.
  const claimed =
    live.length > 0
      ? await transitionAttachments({
          db: args.db,
          now,
          to: { status: "delete_requested" },
          where: and(
            inArray(
              juniorAttachments.id,
              live.map((row) => row.id),
            ),
            inArray(
              juniorAttachments.storageKey,
              live.map((row) => row.storageKey),
            ),
          )!,
        })
      : [];
  const keys = [
    ...rows
      .filter((row) => row.status === "delete_requested")
      .map((row) => row.storageKey),
    ...claimed.map((row) => row.storageKey),
  ];
  if (keys.length === 0) return { deleted: 0 };

  await args.storage.delete(keys);
  const removed = await transitionAttachments({
    db: args.db,
    now,
    to: { status: "collected" },
    where: and(
      inArray(
        juniorAttachments.id,
        rows.map((row) => row.id),
      ),
      inArray(juniorAttachments.storageKey, keys),
    )!,
  });
  return { deleted: removed.length };
}
