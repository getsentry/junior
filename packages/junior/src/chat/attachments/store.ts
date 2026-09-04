import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorAttachments, juniorConversations } from "@/db/schema";
import type { SandboxFileUpload } from "@/chat/tools/sandbox/file-uploads";
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
  storageProvider: string;
  sha256: string;
}): string {
  return createHash("sha256")
    .update(
      [
        args.conversationId,
        args.storageProvider,
        args.sha256,
        args.filename,
        args.contentType,
      ].join("\0"),
    )
    .digest("hex");
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

/** Mark a just-written row for deletion and drop its unused object. */
async function rejectPurgedAttachmentWrite(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  id: string;
  now: Date;
  storage: AttachmentStorage;
  storageKey: string;
}): Promise<never> {
  await args.db
    .db()
    .update(juniorAttachments)
    .set({ deleteRequestedAt: args.now })
    .where(eq(juniorAttachments.id, args.id));
  await bestEffortDelete(args.storage, args.storageKey);
  throw purgedConversationError(args.conversationId);
}

/**
 * Return another writer's live row only when the conversation is still active.
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

/**
 * Persist one conversation-owned file.
 *
 * Identity is content-stable under the conversation. Object storage is written
 * first under a unique key; the SQL row is created only after that write
 * succeeds. A row means the attachment is durable. Retries reuse an existing
 * live row. A purge-marked row is revived by writing a new object and pointing
 * the row at it, unless the conversation is still purged. If the SQL write
 * fails after object storage accepts the bytes, this path deletes that unique
 * object. A process crash between those steps can leave an unreferenced unique
 * object with no SQL row.
 */
export async function storeAttachment(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  file: SandboxFileUpload;
  nowMs?: number;
  storage: AttachmentStorage;
}): Promise<StoredAttachment> {
  const now = new Date(args.nowMs ?? Date.now());
  const sha256 = attachmentDigest(args.file);
  const id = attachmentId({
    conversationId: args.conversationId,
    contentType: args.file.mimeType,
    filename: args.file.filename,
    storageProvider: args.storage.provider,
    sha256,
  });
  const [existing] = await args.db
    .db()
    .select({
      contentType: juniorAttachments.contentType,
      conversationId: juniorAttachments.conversationId,
      deleteRequestedAt: juniorAttachments.deleteRequestedAt,
      filename: juniorAttachments.filename,
      id: juniorAttachments.id,
      storageProvider: juniorAttachments.storageProvider,
      sha256: juniorAttachments.sha256,
      storageKey: juniorAttachments.storageKey,
    })
    .from(juniorAttachments)
    .where(eq(juniorAttachments.id, id));
  if (existing) {
    if (
      existing.contentType !== args.file.mimeType ||
      existing.conversationId !== args.conversationId ||
      existing.filename !== args.file.filename ||
      existing.storageProvider !== args.storage.provider ||
      existing.sha256 !== sha256
    ) {
      throw new Error(`Attachment write conflicts with ${existing.id}`);
    }
    if (existing.deleteRequestedAt === null) {
      await assertConversationNotPurged(args.db, args.conversationId);
      return { id: existing.id };
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

  if (existing?.deleteRequestedAt != null) {
    if (await isConversationPurged(args.db, args.conversationId)) {
      await bestEffortDelete(args.storage, storageKey);
      throw purgedConversationError(args.conversationId);
    }
    const oldStorageKey = existing.storageKey;
    const revived = await args.db
      .db()
      .update(juniorAttachments)
      .set({
        deleteRequestedAt: null,
        storageKey,
      })
      .where(
        and(
          eq(juniorAttachments.id, id),
          isNotNull(juniorAttachments.deleteRequestedAt),
        ),
      )
      .returning({ id: juniorAttachments.id });
    if (revived.length > 0) {
      if (await isConversationPurged(args.db, args.conversationId)) {
        await rejectPurgedAttachmentWrite({
          conversationId: args.conversationId,
          db: args.db,
          id,
          now,
          storage: args.storage,
          storageKey,
        });
      }
      if (oldStorageKey !== storageKey) {
        await bestEffortDelete(args.storage, oldStorageKey);
      }
      return { id };
    }
    const [afterRace] = await args.db
      .db()
      .select({
        deleteRequestedAt: juniorAttachments.deleteRequestedAt,
        id: juniorAttachments.id,
        storageKey: juniorAttachments.storageKey,
      })
      .from(juniorAttachments)
      .where(eq(juniorAttachments.id, id));
    if (afterRace?.deleteRequestedAt === null) {
      return reuseLiveAttachment({
        conversationId: args.conversationId,
        db: args.db,
        id: afterRace.id,
        storage: args.storage,
        storageKey,
      });
    }
  }

  let inserted: Array<{ id: string }> = [];
  try {
    inserted = await args.db
      .db()
      .insert(juniorAttachments)
      .values({
        id,
        conversationId: args.conversationId,
        storageProvider: args.storage.provider,
        storageKey,
        filename: args.file.filename,
        contentType: args.file.mimeType,
        bytes: args.file.bytes,
        sha256,
        createdAt: now,
      })
      .onConflictDoNothing({ target: juniorAttachments.id })
      .returning({ id: juniorAttachments.id });
  } catch (error) {
    // Only clean up when the insert itself failed. Post-insert purge handling
    // must not delete a blob for a row that already committed.
    await bestEffortDelete(args.storage, storageKey);
    throw error;
  }
  if (inserted.length > 0) {
    if (await isConversationPurged(args.db, args.conversationId)) {
      await rejectPurgedAttachmentWrite({
        conversationId: args.conversationId,
        db: args.db,
        id,
        now,
        storage: args.storage,
        storageKey,
      });
    }
    return { id };
  }

  const [row] = await args.db
    .db()
    .select({
      deleteRequestedAt: juniorAttachments.deleteRequestedAt,
      id: juniorAttachments.id,
      storageKey: juniorAttachments.storageKey,
    })
    .from(juniorAttachments)
    .where(eq(juniorAttachments.id, id));
  if (!row) {
    await bestEffortDelete(args.storage, storageKey);
    throw new Error(`Attachment row missing after write for ${id}`);
  }
  if (row.deleteRequestedAt === null) {
    // Another writer owns the live row. Our unique object is unused.
    return reuseLiveAttachment({
      conversationId: args.conversationId,
      db: args.db,
      id: row.id,
      storage: args.storage,
      storageKey,
    });
  }

  if (await isConversationPurged(args.db, args.conversationId)) {
    await bestEffortDelete(args.storage, storageKey);
    throw purgedConversationError(args.conversationId);
  }

  const revived = await args.db
    .db()
    .update(juniorAttachments)
    .set({
      deleteRequestedAt: null,
      storageKey,
    })
    .where(
      and(
        eq(juniorAttachments.id, id),
        isNotNull(juniorAttachments.deleteRequestedAt),
      ),
    )
    .returning({ id: juniorAttachments.id });
  if (revived.length > 0) {
    if (await isConversationPurged(args.db, args.conversationId)) {
      await rejectPurgedAttachmentWrite({
        conversationId: args.conversationId,
        db: args.db,
        id,
        now,
        storage: args.storage,
        storageKey,
      });
    }
    if (row.storageKey !== storageKey) {
      await bestEffortDelete(args.storage, row.storageKey);
    }
    return { id };
  }

  const [afterRace] = await args.db
    .db()
    .select({
      deleteRequestedAt: juniorAttachments.deleteRequestedAt,
      id: juniorAttachments.id,
    })
    .from(juniorAttachments)
    .where(eq(juniorAttachments.id, id));
  if (afterRace?.deleteRequestedAt === null) {
    return reuseLiveAttachment({
      conversationId: args.conversationId,
      db: args.db,
      id: afterRace.id,
      storage: args.storage,
      storageKey,
    });
  }

  await bestEffortDelete(args.storage, storageKey);
  throw new Error(`Attachment ${id} disappeared while reviving`);
}

/** Load one live attachment owned by a conversation. */
export async function readLiveAttachment(args: {
  attachmentId: string;
  conversationId: string;
  db: JuniorSqlDatabase;
}): Promise<AttachmentRecord | null> {
  const [row] = await args.db
    .db()
    .select({
      bytes: juniorAttachments.bytes,
      contentType: juniorAttachments.contentType,
      conversationId: juniorAttachments.conversationId,
      deleteRequestedAt: juniorAttachments.deleteRequestedAt,
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
        isNull(juniorAttachments.deleteRequestedAt),
      ),
    );
  if (!row) return null;
  if (await isConversationPurged(args.db, args.conversationId)) {
    return null;
  }
  return {
    bytes: row.bytes,
    contentType: row.contentType,
    conversationId: row.conversationId,
    filename: row.filename,
    id: row.id,
    storageKey: row.storageKey,
    storageProvider: row.storageProvider,
  };
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
  await db
    .db()
    .update(juniorAttachments)
    .set({ deleteRequestedAt: new Date(nowMs) })
    .where(
      and(
        inArray(juniorAttachments.conversationId, conversationIds),
        isNull(juniorAttachments.deleteRequestedAt),
      ),
    );
}

/**
 * Delete purged attachments in one bounded batch.
 *
 * Eligible rows are 30 days old, explicitly purge-marked, or owned by a
 * conversation whose transcript is already purged. Delete object keys first,
 * then remove rows that are still eligible so a failed blob delete remains
 * retryable.
 */
export async function collectAttachmentGarbage(args: {
  db: JuniorSqlDatabase;
  nowMs: number;
  storage: AttachmentStorage;
  limit?: number;
}): Promise<AttachmentGarbageCollectionResult> {
  const expiresBefore = new Date(args.nowMs - ATTACHMENT_RETENTION_MS);
  const rows = await args.db
    .db()
    .select({
      id: juniorAttachments.id,
      storageKey: juniorAttachments.storageKey,
    })
    .from(juniorAttachments)
    .innerJoin(
      juniorConversations,
      eq(
        juniorAttachments.conversationId,
        juniorConversations.conversationId,
      ),
    )
    .where(
      and(
        eq(juniorAttachments.storageProvider, args.storage.provider),
        or(
          lte(juniorAttachments.createdAt, expiresBefore),
          isNotNull(juniorAttachments.deleteRequestedAt),
          isNotNull(juniorConversations.transcriptPurgedAt),
        ),
      ),
    )
    .orderBy(asc(juniorAttachments.createdAt), asc(juniorAttachments.id))
    .limit(args.limit ?? ATTACHMENT_GC_BATCH_LIMIT);
  if (rows.length === 0) return { deleted: 0 };

  await args.storage.delete(rows.map((row) => row.storageKey));
  const stillEligible = await args.db
    .db()
    .select({ id: juniorAttachments.id })
    .from(juniorAttachments)
    .innerJoin(
      juniorConversations,
      eq(
        juniorAttachments.conversationId,
        juniorConversations.conversationId,
      ),
    )
    .where(
      and(
        inArray(
          juniorAttachments.id,
          rows.map((row) => row.id),
        ),
        or(
          lte(juniorAttachments.createdAt, expiresBefore),
          isNotNull(juniorAttachments.deleteRequestedAt),
          isNotNull(juniorConversations.transcriptPurgedAt),
        ),
      ),
    );
  if (stillEligible.length === 0) return { deleted: 0 };
  const removed = await args.db
    .db()
    .delete(juniorAttachments)
    .where(
      inArray(
        juniorAttachments.id,
        stillEligible.map((row) => row.id),
      ),
    )
    .returning({
      id: juniorAttachments.id,
    });
  return { deleted: removed.length };
}
