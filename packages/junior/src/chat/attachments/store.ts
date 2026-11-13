import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorAttachments, juniorConversations } from "@/db/schema";
import type { SandboxFileUpload } from "@/chat/tools/sandbox/file-uploads";
import {
  conversationDetailTouch,
  touchConversationDetail,
} from "@/chat/conversations/sql/detail-version";
import { bufferBody, type AttachmentStorage } from "./storage";

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

/** Where a stored file came from, such as one Slack file. */
export interface AttachmentSource {
  id: string;
  provider: string;
}

/**
 * One file to store.
 *
 * A file with a source can stream. Its id comes from the source, so a retry
 * finds the stored copy before `open` downloads anything. A file without a
 * source must be in memory, because its id comes from its digest.
 */
export type AttachmentFile = {
  filename: string;
  mimeType: string;
} & (
  | { data: Buffer; source?: AttachmentSource }
  | {
      /** Size that the source declares. The stored body must match it. */
      bytes: number;
      open: () => Promise<ReadableStream<Uint8Array>>;
      source: AttachmentSource;
    }
);

type AttachmentIdentity = AttachmentSource | { sha256: string };

function attachmentIdentity(file: AttachmentFile): AttachmentIdentity {
  if ("data" in file) {
    return (
      file.source ?? {
        sha256: createHash("sha256").update(file.data).digest("hex"),
      }
    );
  }
  return file.source;
}

/** Stable conversation-owned id for one file and its presentation metadata. */
function attachmentId(args: {
  conversationId: string;
  contentType: string;
  filename: string;
  identity: AttachmentIdentity;
  storageProvider: string;
}): string {
  // A digest identity keeps the field order of ids stored before sources
  // existed, so those rows still match.
  const identity =
    "sha256" in args.identity
      ? [
          args.conversationId,
          args.storageProvider,
          args.identity.sha256,
          args.filename,
          args.contentType,
        ]
      : [
          args.conversationId,
          args.storageProvider,
          args.filename,
          args.contentType,
          args.identity.provider,
          args.identity.id,
        ];
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

/** A source whose bytes do not match its declared size. A retry cannot fix it. */
class AttachmentSizeError extends Error {
  constructor(bytes: number, expected: number, options?: ErrorOptions) {
    super(
      `Attachment body does not match its declared ${expected} bytes (read ${bytes})`,
      options,
    );
    this.name = "AttachmentSizeError";
  }
}

/** Tries for one object write, each with a freshly opened body. */
const WRITE_ATTEMPTS = 3;

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

/**
 * Stream one file to a fresh key, and return its size and digest.
 *
 * The digest is taken while the bytes stream, so the body is never held
 * whole. A body that does not match its declared size is not kept.
 */
async function writeAttachmentObject(args: {
  file: AttachmentFile;
  key: string;
  storage: AttachmentStorage;
}): Promise<{ bytes: number; sha256: string }> {
  // A stream is read once, so the storage client cannot replay it. Retry
  // here with a fresh body instead. Write failures are mostly transient
  // (5xx, throttling, a dropped connection); a lasting one fails every try.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await writeAttachmentObjectOnce(args);
    } catch (error) {
      if (error instanceof AttachmentSizeError || attempt >= WRITE_ATTEMPTS) {
        // A write that committed before it failed leaves an object no row
        // points to.
        await bestEffortDelete(args.storage, args.key);
        throw error;
      }
    }
  }
}

async function writeAttachmentObjectOnce(args: {
  file: AttachmentFile;
  key: string;
  storage: AttachmentStorage;
}): Promise<{ bytes: number; sha256: string }> {
  const { file } = args;
  const expected = "data" in file ? file.data.byteLength : file.bytes;
  const source = "data" in file ? bufferBody(file.data) : await file.open();
  const hash = createHash("sha256");
  let bytes = 0;
  const body = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > expected) {
          throw new AttachmentSizeError(bytes, expected);
        }
        hash.update(chunk);
        controller.enqueue(chunk);
      },
    }),
  );
  try {
    await args.storage.put({
      body,
      bytes: expected,
      contentType: file.mimeType,
      key: args.key,
    });
  } catch (error) {
    if (bytes > expected) {
      throw new AttachmentSizeError(bytes, expected, { cause: error });
    }
    throw error;
  }
  if (bytes !== expected) {
    throw new AttachmentSizeError(bytes, expected);
  }
  return { bytes, sha256: hash.digest("hex") };
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
  const db = args.db.db();
  await db
    .with(conversationDetailTouch(db, [args.conversationId]))
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
 * Identity is stable under the conversation: it comes from the file's source
 * when it has one, and from its digest otherwise. Object storage is written
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
  file: AttachmentFile;
  nowMs?: number;
  storage: AttachmentStorage;
}): Promise<StoredAttachment> {
  const now = new Date(args.nowMs ?? Date.now());
  const identity = attachmentIdentity(args.file);
  const source = args.file.source;
  const id = attachmentId({
    conversationId: args.conversationId,
    contentType: args.file.mimeType,
    filename: args.file.filename,
    identity,
    storageProvider: args.storage.provider,
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
      providerId: juniorAttachments.providerId,
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
      existing.provider !== (source?.provider ?? null) ||
      existing.providerId !== (source?.id ?? null) ||
      existing.storageProvider !== args.storage.provider ||
      ("sha256" in identity && existing.sha256 !== identity.sha256)
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
  const written = await writeAttachmentObject({
    file: args.file,
    key: storageKey,
    storage: args.storage,
  });

  if (existing?.deleteRequestedAt != null) {
    if (await isConversationPurged(args.db, args.conversationId)) {
      await bestEffortDelete(args.storage, storageKey);
      throw purgedConversationError(args.conversationId);
    }
    const oldStorageKey = existing.storageKey;
    const revived = await args.db
      .db()
      .with(conversationDetailTouch(args.db.db(), [args.conversationId]))
      .update(juniorAttachments)
      .set({
        ...written,
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
      .with(conversationDetailTouch(args.db.db(), [args.conversationId]))
      .insert(juniorAttachments)
      .values({
        id,
        conversationId: args.conversationId,
        storageProvider: args.storage.provider,
        storageKey,
        provider: source?.provider,
        providerId: source?.id,
        filename: args.file.filename,
        contentType: args.file.mimeType,
        ...written,
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
    .with(conversationDetailTouch(args.db.db(), [args.conversationId]))
    .update(juniorAttachments)
    .set({
      ...written,
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

/**
 * Record an object that a browser already wrote, under the upload's id.
 *
 * The row takes over the object key. A retry with the same id keeps the
 * first row. The caller checked the object's size, type, and digest.
 */
export async function recordUploadedAttachment(args: {
  attachment: Omit<AttachmentRecord, "storageProvider"> & { sha256: string };
  db: JuniorSqlDatabase;
  nowMs: number;
  storage: AttachmentStorage;
}): Promise<void> {
  const { attachment } = args;
  const now = new Date(args.nowMs);
  await assertConversationNotPurged(args.db, attachment.conversationId);
  const inserted = await args.db
    .db()
    .with(conversationDetailTouch(args.db.db(), [attachment.conversationId]))
    .insert(juniorAttachments)
    .values({
      ...attachment,
      storageProvider: args.storage.provider,
      createdAt: now,
    })
    .onConflictDoNothing({ target: juniorAttachments.id })
    .returning({ id: juniorAttachments.id });
  if (
    inserted.length > 0 &&
    (await isConversationPurged(args.db, attachment.conversationId))
  ) {
    await rejectPurgedAttachmentWrite({
      conversationId: attachment.conversationId,
      db: args.db,
      id: attachment.id,
      now,
      storage: args.storage,
      storageKey: attachment.storageKey,
    });
  }
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
        file: {
          data: file.data,
          filename: file.filename,
          mimeType: file.mimeType,
        },
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
    .with(conversationDetailTouch(db.db(), conversationIds))
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
      eq(juniorAttachments.conversationId, juniorConversations.conversationId),
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
      eq(juniorAttachments.conversationId, juniorConversations.conversationId),
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
      conversationId: juniorAttachments.conversationId,
    });
  await touchConversationDetail(
    args.db.db(),
    removed.map((row) => row.conversationId),
  );
  return { deleted: removed.length };
}
