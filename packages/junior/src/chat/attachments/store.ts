import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorAttachments } from "@/db/schema";
import type { SandboxFileUpload } from "@/chat/tools/sandbox/file-uploads";
import type { AttachmentStorage } from "./storage";

const ATTACHMENT_GC_BATCH_LIMIT = 200;

export interface StoredAttachment {
  id: string;
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
  provider: string;
  sha256: string;
}): string {
  return createHash("sha256")
    .update(
      [
        args.conversationId,
        args.provider,
        args.sha256,
        args.filename,
        args.contentType,
      ].join("\0"),
    )
    .digest("hex");
}

function attachmentKey(args: {
  attachmentId: string;
  conversationId: string;
  filename: string;
}): string {
  return `conversations/${args.conversationId}/attachments/${args.attachmentId}/${args.filename}`;
}

async function bestEffortDelete(
  storage: AttachmentStorage,
  key: string,
): Promise<void> {
  try {
    await storage.delete([key]);
  } catch {
    // Leave the blob. A later store of the same content overwrites the key.
  }
}

/** Clear a purge mark after rewriting the blob for the same attachment id. */
async function clearDeletionMark(
  db: JuniorSqlDatabase,
  id: string,
): Promise<"live" | "missing"> {
  const revived = await db
    .db()
    .update(juniorAttachments)
    .set({ deleteRequestedAt: null })
    .where(
      and(
        eq(juniorAttachments.id, id),
        isNotNull(juniorAttachments.deleteRequestedAt),
      ),
    )
    .returning({ id: juniorAttachments.id });
  if (revived.length > 0) return "live";
  const [row] = await db
    .db()
    .select({
      deleteRequestedAt: juniorAttachments.deleteRequestedAt,
      id: juniorAttachments.id,
    })
    .from(juniorAttachments)
    .where(eq(juniorAttachments.id, id));
  if (row?.deleteRequestedAt === null) return "live";
  return "missing";
}

/**
 * Persist one conversation-owned file.
 *
 * Identity is content-stable under the conversation. Object storage is written
 * first; the SQL row is created only after that write succeeds. A row means the
 * attachment is durable. Retries reuse an existing live row. A purge-marked row
 * is revived by rewriting the blob and clearing the mark. If the SQL write
 * fails after object storage accepts the bytes, this path deletes that blob.
 * A process crash between those steps can leave an unreferenced blob on a
 * stable key; the next store of the same content overwrites it.
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
    provider: args.storage.provider,
    sha256,
  });
  const storageKey = attachmentKey({
    attachmentId: id,
    conversationId: args.conversationId,
    filename: args.file.filename,
  });
  const [existing] = await args.db
    .db()
    .select({
      contentType: juniorAttachments.contentType,
      conversationId: juniorAttachments.conversationId,
      deleteRequestedAt: juniorAttachments.deleteRequestedAt,
      filename: juniorAttachments.filename,
      id: juniorAttachments.id,
      provider: juniorAttachments.provider,
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
      existing.provider !== args.storage.provider ||
      existing.sha256 !== sha256 ||
      existing.storageKey !== storageKey
    ) {
      throw new Error(`Attachment write conflicts with ${existing.id}`);
    }
    if (existing.deleteRequestedAt === null) {
      return { id: existing.id };
    }
  }

  await args.storage.put({
    body: args.file.data,
    contentType: args.file.mimeType,
    key: storageKey,
  });

  if (existing?.deleteRequestedAt != null) {
    if ((await clearDeletionMark(args.db, id)) === "live") {
      return { id };
    }
  }

  try {
    const inserted = await args.db
      .db()
      .insert(juniorAttachments)
      .values({
        id,
        conversationId: args.conversationId,
        provider: args.storage.provider,
        storageKey,
        filename: args.file.filename,
        contentType: args.file.mimeType,
        bytes: args.file.bytes,
        sha256,
        createdAt: now,
      })
      .onConflictDoNothing({ target: juniorAttachments.id })
      .returning({ id: juniorAttachments.id });
    if (inserted.length > 0) {
      return { id };
    }
  } catch (error) {
    await bestEffortDelete(args.storage, storageKey);
    throw error;
  }

  const [row] = await args.db
    .db()
    .select({
      deleteRequestedAt: juniorAttachments.deleteRequestedAt,
      id: juniorAttachments.id,
    })
    .from(juniorAttachments)
    .where(eq(juniorAttachments.id, id));
  if (!row) {
    await bestEffortDelete(args.storage, storageKey);
    throw new Error(`Attachment row missing after write for ${id}`);
  }
  if (row.deleteRequestedAt === null) {
    return { id: row.id };
  }
  // Conflicted with a purge-marked row. Blob was rewritten above; clear the mark.
  if ((await clearDeletionMark(args.db, id)) === "missing") {
    await bestEffortDelete(args.storage, storageKey);
    throw new Error(`Attachment ${id} disappeared while reviving`);
  }
  return { id: row.id };
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
        ...(args.nowMs !== undefined ? { nowMs: args.nowMs } : {}),
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
 * Remove still-marked SQL rows first, then delete object keys that were not
 * reclaimed by a concurrent revive. This keeps blob deletion from racing a
 * later store of the same content-stable key.
 */
export async function collectAttachmentGarbage(args: {
  db: JuniorSqlDatabase;
  nowMs: number;
  storage: AttachmentStorage;
  limit?: number;
}): Promise<AttachmentGarbageCollectionResult> {
  void args.nowMs;
  const rows = await args.db
    .db()
    .select({
      id: juniorAttachments.id,
      storageKey: juniorAttachments.storageKey,
    })
    .from(juniorAttachments)
    .where(
      and(
        eq(juniorAttachments.provider, args.storage.provider),
        isNotNull(juniorAttachments.deleteRequestedAt),
      ),
    )
    .orderBy(asc(juniorAttachments.createdAt), asc(juniorAttachments.id))
    .limit(args.limit ?? ATTACHMENT_GC_BATCH_LIMIT);
  if (rows.length === 0) return { deleted: 0 };

  const removed = await args.db
    .db()
    .delete(juniorAttachments)
    .where(
      and(
        inArray(
          juniorAttachments.id,
          rows.map((row) => row.id),
        ),
        isNotNull(juniorAttachments.deleteRequestedAt),
      ),
    )
    .returning({
      storageKey: juniorAttachments.storageKey,
    });
  if (removed.length === 0) return { deleted: 0 };

  const removedKeys = [...new Set(removed.map((row) => row.storageKey))];
  const reclaimed = await args.db
    .db()
    .select({ storageKey: juniorAttachments.storageKey })
    .from(juniorAttachments)
    .where(inArray(juniorAttachments.storageKey, removedKeys));
  const reclaimedKeys = new Set(reclaimed.map((row) => row.storageKey));
  const keysToDelete = removedKeys.filter((key) => !reclaimedKeys.has(key));
  if (keysToDelete.length > 0) {
    await args.storage.delete(keysToDelete);
  }
  return { deleted: removed.length };
}
