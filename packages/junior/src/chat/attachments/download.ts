import type { JuniorSqlDatabase } from "@/db/db";
import { withSpan } from "@/chat/logging";
import { MAX_ATTACHMENT_BYTES } from "./input";
import {
  AttachmentSourceUnavailableError,
  type AttachmentSource,
  type AttachmentSourceFile,
  type ReadAttachmentSource,
} from "./source";
import type { AttachmentStorage } from "./storage";
import {
  storeDeferredAttachment,
  type AttachmentRecord,
  type StoredAttachmentRecord,
} from "./store";

/** Refusal for a file over `MAX_ATTACHMENT_BYTES`. */
export const ATTACHMENT_TOO_LARGE_MESSAGE = `Attachment is larger than the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB file limit.`;

/** An attachment whose bytes cannot be read. The message is safe to show. */
export class AttachmentDownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AttachmentDownloadError";
  }
}

/** The bytes of one attachment, ready to open. */
export interface AttachmentContent {
  bytes: number;
  open: () => Promise<ReadableStream<Uint8Array>>;
}

/**
 * Look up the source file of an unstored row, with the size check done.
 * Errors that the person should see are `AttachmentDownloadError`.
 */
async function readSourceFile(
  attachment: AttachmentRecord,
  readAttachmentSource: ReadAttachmentSource | undefined,
): Promise<{ file: AttachmentSourceFile; source: AttachmentSource }> {
  const { source } = attachment;
  if (!source || !readAttachmentSource) {
    throw new AttachmentDownloadError(
      "Attachment cannot be downloaded from this conversation.",
    );
  }
  let file;
  try {
    file = await readAttachmentSource(source);
  } catch (error) {
    throw unavailableError(attachment, error);
  }
  if (file.bytes > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentDownloadError(ATTACHMENT_TOO_LARGE_MESSAGE);
  }
  return { file, source };
}

function unavailableError(attachment: AttachmentRecord, error: unknown) {
  return error instanceof AttachmentSourceUnavailableError
    ? new AttachmentDownloadError(
        `${attachment.filename} is no longer available: ${error.message}`,
        { cause: error },
      )
    : error;
}

/**
 * Find where the bytes of one attachment row are, without reading them.
 *
 * A stored file reads from storage. A large Slack file that no read has
 * stored yet downloads from its source on each `open`. The source reports
 * the current size, and the size check runs before any download. Errors that
 * the person should see are `AttachmentDownloadError`, from here or from
 * `open`. Callers that need the bytes more than once use
 * `storeAttachmentOnFirstUse` first.
 *
 * The row must come from a lookup scoped to the caller's conversation. The
 * source id comes from that row only, never from a request.
 */
export async function readAttachmentContent(args: {
  attachment: AttachmentRecord;
  readAttachmentSource?: ReadAttachmentSource | undefined;
  storage: AttachmentStorage;
}): Promise<AttachmentContent> {
  const { attachment, storage } = args;
  const { storageKey } = attachment;
  if (storageKey !== null) {
    return {
      bytes: attachment.bytes,
      open: async () => {
        const body = await storage.get(storageKey);
        if (!body) {
          throw new AttachmentDownloadError(
            "Stored attachment contents are unavailable.",
          );
        }
        return body;
      },
    };
  }
  const { file } = await readSourceFile(attachment, args.readAttachmentSource);
  return {
    bytes: file.bytes,
    open: async () => {
      try {
        return await file.open();
      } catch (error) {
        throw unavailableError(attachment, error);
      }
    },
  };
}

/**
 * Return the row of one attachment with its bytes in storage.
 *
 * A large Slack file is recorded without its bytes. The first read that
 * needs them streams the file from its source into storage once, and later
 * reads use storage. The same rules as `readAttachmentContent` apply to the
 * row and to errors.
 */
export async function storeAttachmentOnFirstUse(args: {
  attachment: AttachmentRecord;
  db: JuniorSqlDatabase;
  readAttachmentSource?: ReadAttachmentSource | undefined;
  storage: AttachmentStorage;
}): Promise<StoredAttachmentRecord> {
  const { attachment } = args;
  const { storageKey } = attachment;
  if (storageKey !== null) return { ...attachment, storageKey };
  const { file, source } = await readSourceFile(
    attachment,
    args.readAttachmentSource,
  );
  let stored;
  try {
    stored = await withSpan(
      "attachment.store",
      "attachment.store",
      {},
      async () =>
        await storeDeferredAttachment({
          attachment: { ...attachment, source },
          db: args.db,
          file,
          storage: args.storage,
        }),
      {
        "app.attachment.source.provider": source.provider,
        "file.size": file.bytes,
      },
    );
  } catch (error) {
    throw unavailableError(attachment, error);
  }
  if (!stored) {
    throw new AttachmentDownloadError(
      `${attachment.filename} is no longer available.`,
    );
  }
  return stored;
}
