import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorAttachments } from "@/db/schema";
import type { SandboxFileUpload } from "@/chat/tools/sandbox/file-uploads";
import type { AttachmentStorage } from "./storage";

const STALE_ATTACHMENT_WRITE_MS = 24 * 60 * 60 * 1000;
const ATTACHMENT_GC_BATCH_LIMIT = 200;

export interface StoredAttachment {
  id: string;
  position: number;
}

export interface AttachmentGarbageCollectionResult {
  deleted: number;
}

function attachmentDigest(file: SandboxFileUpload): string {
  return createHash("sha256").update(file.data).digest("hex");
}

function attachmentKey(args: {
  attachmentId: string;
  conversationId: string;
  filename: string;
}): string {
  return `conversations/${args.conversationId}/attachments/${args.attachmentId}/${args.filename}`;
}

/** Persist materialized files before a provider sends them to its destination. */
export async function storeAttachments(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  files: SandboxFileUpload[];
  nowMs?: number;
  storage: AttachmentStorage;
  toolCallId: string;
}): Promise<StoredAttachment[]> {
  const now = new Date(args.nowMs ?? Date.now());
  const stored: StoredAttachment[] = [];
  for (const [position, file] of args.files.entries()) {
    const [existing] = await args.db
      .db()
      .select({
        contentType: juniorAttachments.contentType,
        filename: juniorAttachments.filename,
        id: juniorAttachments.id,
        position: juniorAttachments.position,
        provider: juniorAttachments.provider,
        readyAt: juniorAttachments.readyAt,
        sha256: juniorAttachments.sha256,
        storageKey: juniorAttachments.storageKey,
      })
      .from(juniorAttachments)
      .where(
        and(
          eq(juniorAttachments.conversationId, args.conversationId),
          eq(juniorAttachments.toolCallId, args.toolCallId),
          eq(juniorAttachments.position, position),
        ),
      );
    const sha256 = attachmentDigest(file);
    if (
      existing &&
      (existing.contentType !== file.mimeType ||
        existing.filename !== file.filename ||
        existing.provider !== args.storage.provider ||
        existing.sha256 !== sha256)
    ) {
      throw new Error(`Attachment write conflicts with ${existing.id}`);
    }
    if (existing?.readyAt) {
      stored.push({ id: existing.id, position: existing.position });
      continue;
    }
    if (existing) {
      await args.storage.put({
        body: file.data,
        contentType: file.mimeType,
        key: existing.storageKey,
      });
      await args.db
        .db()
        .update(juniorAttachments)
        .set({ readyAt: now })
        .where(eq(juniorAttachments.id, existing.id));
      stored.push({ id: existing.id, position: existing.position });
      continue;
    }

    const id = randomUUID();
    const storageKey = attachmentKey({
      attachmentId: id,
      conversationId: args.conversationId,
      filename: file.filename,
    });
    await args.db.db().insert(juniorAttachments).values({
      id,
      conversationId: args.conversationId,
      toolCallId: args.toolCallId,
      position,
      provider: args.storage.provider,
      storageKey,
      filename: file.filename,
      contentType: file.mimeType,
      bytes: file.bytes,
      sha256,
      createdAt: now,
    });
    await args.storage.put({
      body: file.data,
      contentType: file.mimeType,
      key: storageKey,
    });
    await args.db
      .db()
      .update(juniorAttachments)
      .set({ readyAt: now })
      .where(eq(juniorAttachments.id, id));
    stored.push({ id, position });
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
    .where(inArray(juniorAttachments.id, rows.map((row) => row.id)));
  return { deleted: rows.length };
}
