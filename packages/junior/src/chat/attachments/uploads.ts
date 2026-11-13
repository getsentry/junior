import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorAttachmentUploads, juniorAttachments } from "@/db/schema";
import type { InputFile, MessageAttachment } from "./input";
import { detectImageMediaType, isVisionImageMediaType } from "./media";
import { readLiveAttachment, recordUploadedAttachment } from "./store";
import {
  bufferBody,
  type AttachmentStorage,
  type AttachmentUploadTarget,
} from "./storage";

const MINUTE_MS = 60 * 1000;
/** Time that a browser has to write the bytes after it asks to upload. */
const UPLOAD_TARGET_TTL_MS = 15 * MINUTE_MS;
/** Time that a written upload can still join a Message. */
const UPLOAD_SEND_WINDOW_MS = 60 * MINUTE_MS;
/**
 * Age at which cleanup deletes an upload that no Message used. It is much
 * longer than the send window, so cleanup cannot race a send.
 */
const UPLOAD_RETENTION_MS = 24 * 60 * MINUTE_MS;
const UPLOAD_GC_BATCH_LIMIT = 200;
/** Leading bytes that image type detection reads. */
const SIGNATURE_BYTES = 16;

/** Who may send one upload, and with which Message. */
export interface AttachmentUploadScope {
  conversationId: string;
  idempotencyKey: string;
  userId: string;
}

/**
 * Upload that a Message can record as a Conversation attachment. An earlier
 * attempt of the same Message may have recorded it already.
 */
export type VerifiedAttachmentUpload =
  | { attachment: MessageAttachment; recorded: true }
  | {
      attachment: MessageAttachment;
      recorded: false;
      sha256: string;
      storageKey: string;
    };

/** A Message refers to an upload that it cannot use. */
export class AttachmentUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentUploadError";
  }
}

/**
 * Reserve one object key for a browser upload.
 *
 * Returns no target when the provider cannot sign browser writes. The caller
 * then takes the bytes with `writeAttachmentUpload`.
 */
export async function createAttachmentUpload(args: {
  db: JuniorSqlDatabase;
  file: InputFile;
  nowMs?: number;
  scope: AttachmentUploadScope;
  storage: AttachmentStorage;
}): Promise<{ id: string; target?: AttachmentUploadTarget }> {
  const nowMs = args.nowMs ?? Date.now();
  const id = randomUUID();
  // The filename stays out of the key. Keys then need no escaping, and the
  // attachment read route sets the download name.
  const storageKey = `conversations/${args.scope.conversationId}/uploads/${id}`;
  await args.db
    .db()
    .insert(juniorAttachmentUploads)
    .values({
      ...args.scope,
      bytes: args.file.bytes,
      contentType: args.file.contentType,
      createdAt: new Date(nowMs),
      filename: args.file.filename,
      id,
      storageKey,
      storageProvider: args.storage.provider,
    });
  const target = await args.storage.createUploadTarget?.({
    bytes: args.file.bytes,
    contentType: args.file.contentType,
    expiresAtMs: nowMs + UPLOAD_TARGET_TTL_MS,
    key: storageKey,
  });
  return target ? { id, target } : { id };
}

async function readUploadRows(args: {
  db: JuniorSqlDatabase;
  nowMs: number;
  scope: AttachmentUploadScope;
  storageProvider: string;
  uploadIds: readonly string[];
}) {
  return await args.db
    .db()
    .select()
    .from(juniorAttachmentUploads)
    .where(
      and(
        inArray(juniorAttachmentUploads.id, [...args.uploadIds]),
        eq(juniorAttachmentUploads.conversationId, args.scope.conversationId),
        eq(juniorAttachmentUploads.idempotencyKey, args.scope.idempotencyKey),
        eq(juniorAttachmentUploads.userId, args.scope.userId),
        eq(juniorAttachmentUploads.storageProvider, args.storageProvider),
        gt(
          juniorAttachmentUploads.createdAt,
          new Date(args.nowMs - UPLOAD_SEND_WINDOW_MS),
        ),
      ),
    );
}

/** Write upload bytes through the API, for providers without browser writes. */
export async function writeAttachmentUpload(args: {
  body: Buffer;
  db: JuniorSqlDatabase;
  nowMs?: number;
  storage: AttachmentStorage;
  uploadId: string;
  userId: string;
}): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  const [row] = await args.db
    .db()
    .select()
    .from(juniorAttachmentUploads)
    .where(
      and(
        eq(juniorAttachmentUploads.id, args.uploadId),
        eq(juniorAttachmentUploads.userId, args.userId),
        eq(juniorAttachmentUploads.storageProvider, args.storage.provider),
        gt(
          juniorAttachmentUploads.createdAt,
          new Date(nowMs - UPLOAD_TARGET_TTL_MS),
        ),
      ),
    );
  if (!row) throw new AttachmentUploadError("Upload not found.");
  // A sent file is a Conversation attachment. Its bytes do not change.
  if (
    await readLiveAttachment({
      attachmentId: row.id,
      conversationId: row.conversationId,
      db: args.db,
    })
  ) {
    throw new AttachmentUploadError("Upload was already sent.");
  }
  if (args.body.byteLength !== row.bytes) {
    throw new AttachmentUploadError("Upload size does not match the file.");
  }
  await args.storage.put({
    body: bufferBody(args.body),
    bytes: row.bytes,
    contentType: row.contentType,
    key: row.storageKey,
  });
}

/** Read a whole object once for its size, digest, and leading bytes. */
async function inspectObject(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: number; head: Buffer; sha256: string } | undefined> {
  const hash = createHash("sha256");
  const head: Buffer[] = [];
  let headBytes = 0;
  let bytes = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    hash.update(value);
    if (headBytes < SIGNATURE_BYTES) {
      head.push(Buffer.from(value.subarray(0, SIGNATURE_BYTES - headBytes)));
      headBytes += head.at(-1)!.byteLength;
    }
  }
  return { bytes, head: Buffer.concat(head), sha256: hash.digest("hex") };
}

/**
 * Pick the type to store from the file signature, not only the browser's
 * guess from the file name. Models reject an image whose bytes do not match
 * its type, so a file that only claims to be an image is stored as bytes.
 */
function storedContentType(declared: string, head: Buffer): string {
  const detected = detectImageMediaType(head);
  if (detected) return detected;
  return isVisionImageMediaType(declared)
    ? "application/octet-stream"
    : declared;
}

/**
 * Check the uploads of one Message before the Message is accepted.
 *
 * Each upload must belong to the scope and be written in full at its
 * declared size. Throws `AttachmentUploadError` for any upload that the
 * Message cannot use.
 */
export async function verifyAttachmentUploads(args: {
  db: JuniorSqlDatabase;
  nowMs?: number;
  scope: AttachmentUploadScope;
  storage: AttachmentStorage;
  uploadIds: readonly string[];
}): Promise<VerifiedAttachmentUpload[]> {
  if (args.uploadIds.length === 0) return [];
  if (new Set(args.uploadIds).size !== args.uploadIds.length) {
    throw new AttachmentUploadError("Attach each file once.");
  }
  const rows = await readUploadRows({
    db: args.db,
    nowMs: args.nowMs ?? Date.now(),
    scope: args.scope,
    storageProvider: args.storage.provider,
    uploadIds: args.uploadIds,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return await Promise.all(
    args.uploadIds.map(async (uploadId) => {
      const row = byId.get(uploadId);
      if (!row) {
        throw new AttachmentUploadError(
          "Upload expired. Attach the file again.",
        );
      }
      const recorded = await readLiveAttachment({
        attachmentId: row.id,
        conversationId: row.conversationId,
        db: args.db,
      });
      if (recorded) {
        return {
          attachment: {
            bytes: recorded.bytes,
            contentType: recorded.contentType,
            filename: recorded.filename,
            id: recorded.id,
          },
          recorded: true as const,
        };
      }
      const body = await args.storage.get(row.storageKey);
      const object = body ? await inspectObject(body, row.bytes) : undefined;
      if (!object || object.bytes !== row.bytes) {
        throw new AttachmentUploadError(
          `Upload of ${row.filename} is not complete. Attach it again.`,
        );
      }
      return {
        attachment: {
          bytes: row.bytes,
          contentType: storedContentType(row.contentType, object.head),
          filename: row.filename,
          id: row.id,
        },
        recorded: false as const,
        sha256: object.sha256,
        storageKey: row.storageKey,
      };
    }),
  );
}

/** Record checked uploads as attachments of their Conversation. */
export async function recordAttachmentUploads(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  nowMs?: number;
  storage: AttachmentStorage;
  uploads: readonly VerifiedAttachmentUpload[];
}): Promise<MessageAttachment[]> {
  for (const upload of args.uploads) {
    if (upload.recorded) continue;
    await recordUploadedAttachment({
      attachment: {
        ...upload.attachment,
        conversationId: args.conversationId,
        sha256: upload.sha256,
        storageKey: upload.storageKey,
      },
      db: args.db,
      nowMs: args.nowMs ?? Date.now(),
      storage: args.storage,
    });
  }
  return args.uploads.map((upload) => upload.attachment);
}

/**
 * Delete old upload rows in one bounded batch.
 *
 * An upload that a Message recorded keeps its object: the attachment row owns
 * it now. Other objects are deleted first, so a failed delete stays
 * retryable.
 */
export async function collectAttachmentUploadGarbage(args: {
  db: JuniorSqlDatabase;
  nowMs: number;
  storage: AttachmentStorage;
}): Promise<{ deleted: number }> {
  const rows = await args.db
    .db()
    .select({
      id: juniorAttachmentUploads.id,
      recordedId: juniorAttachments.id,
      storageKey: juniorAttachmentUploads.storageKey,
    })
    .from(juniorAttachmentUploads)
    .leftJoin(
      juniorAttachments,
      eq(juniorAttachments.id, juniorAttachmentUploads.id),
    )
    .where(
      and(
        eq(juniorAttachmentUploads.storageProvider, args.storage.provider),
        lte(
          juniorAttachmentUploads.createdAt,
          new Date(args.nowMs - UPLOAD_RETENTION_MS),
        ),
      ),
    )
    .orderBy(asc(juniorAttachmentUploads.createdAt))
    .limit(UPLOAD_GC_BATCH_LIMIT);
  if (rows.length === 0) return { deleted: 0 };
  const unusedKeys = rows
    .filter((row) => row.recordedId === null)
    .map((row) => row.storageKey);
  await args.storage.delete(unusedKeys);
  const removed = await args.db
    .db()
    .delete(juniorAttachmentUploads)
    .where(
      inArray(
        juniorAttachmentUploads.id,
        rows.map((row) => row.id),
      ),
    )
    .returning({ id: juniorAttachmentUploads.id });
  return { deleted: removed.length };
}
