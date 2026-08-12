import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorAttachments } from "@/db/schema";
import type { SandboxFileUpload } from "@/chat/tools/sandbox/file-uploads";
import type { AttachmentStorage } from "./storage";

const STALE_ATTACHMENT_WRITE_MS = 24 * 60 * 60 * 1000;
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

/**
 * Persist one conversation-owned file.
 *
 * Identity is content-stable under the conversation: the same bytes, filename,
 * content type, and storage provider reuse one attachment id. Retries resume an
 * incomplete write or return the ready row instead of creating duplicates.
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
      filename: juniorAttachments.filename,
      id: juniorAttachments.id,
      provider: juniorAttachments.provider,
      readyAt: juniorAttachments.readyAt,
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
    if (existing.readyAt) {
      return { id: existing.id };
    }
    await args.storage.put({
      body: args.file.data,
      contentType: args.file.mimeType,
      key: existing.storageKey,
    });
    await args.db
      .db()
      .update(juniorAttachments)
      .set({ readyAt: now })
      .where(eq(juniorAttachments.id, existing.id));
    return { id: existing.id };
  }

  await args.db
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
    .onConflictDoNothing({ target: juniorAttachments.id });
  await args.storage.put({
    body: args.file.data,
    contentType: args.file.mimeType,
    key: storageKey,
  });
  await args.db
    .db()
    .update(juniorAttachments)
    .set({ readyAt: now })
    .where(eq(juniorAttachments.id, id));
  return { id };
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

/** Delete requested or abandoned blobs in one bounded batch. */
export async function collectAttachmentGarbage(args: {
  db: JuniorSqlDatabase;
  nowMs: number;
  storage: AttachmentStorage;
  limit?: number;
}): Promise<AttachmentGarbageCollectionResult> {
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
        or(
          isNotNull(juniorAttachments.deleteRequestedAt),
          and(
            isNull(juniorAttachments.readyAt),
            lt(
              juniorAttachments.createdAt,
              new Date(args.nowMs - STALE_ATTACHMENT_WRITE_MS),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(juniorAttachments.createdAt), asc(juniorAttachments.id))
    .limit(args.limit ?? ATTACHMENT_GC_BATCH_LIMIT);
  if (rows.length === 0) return { deleted: 0 };
  await args.storage.delete(rows.map((row) => row.storageKey));
  await args.db
    .db()
    .delete(juniorAttachments)
    .where(
      inArray(
        juniorAttachments.id,
        rows.map((row) => row.id),
      ),
    );
  return { deleted: rows.length };
}
