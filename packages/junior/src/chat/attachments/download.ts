import type { JuniorSqlDatabase } from "@/db/db";
import { MAX_ATTACHMENT_BYTES } from "./input";
import {
  AttachmentSourceUnavailableError,
  type ReadAttachmentSource,
} from "./source";
import type { AttachmentStorage } from "./storage";
import { storeDeferredAttachment, type AttachmentRecord } from "./store";

/** Refusal for a file over `MAX_ATTACHMENT_BYTES`. */
export const ATTACHMENT_TOO_LARGE_MESSAGE = `Attachment is larger than the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB file limit.`;

/** A pending file that cannot be downloaded. The message is safe to show. */
export class AttachmentDownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AttachmentDownloadError";
  }
}

/**
 * Make sure a stored copy of one attachment exists, and return its row.
 *
 * A file that Junior recorded without its bytes downloads from its source
 * into storage now. The size check runs before the download. A stored file
 * returns at once. `loadAttachment` and the dashboard download share this,
 * so both reuse the copy that the other stored.
 */
export async function ensureAttachmentStored(args: {
  attachment: AttachmentRecord;
  db: JuniorSqlDatabase;
  readAttachmentSource?: ReadAttachmentSource;
  storage: AttachmentStorage;
}): Promise<AttachmentRecord & { storageKey: string }> {
  const { attachment } = args;
  if (attachment.storageKey !== null) {
    return { ...attachment, storageKey: attachment.storageKey };
  }
  const { source } = attachment;
  if (!source || !args.readAttachmentSource) {
    throw new AttachmentDownloadError(
      "Attachment has not been downloaded, and it cannot be downloaded from this conversation.",
    );
  }
  try {
    const file = await args.readAttachmentSource(source);
    if (file.bytes > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentDownloadError(ATTACHMENT_TOO_LARGE_MESSAGE);
    }
    return await storeDeferredAttachment({
      attachment: { ...attachment, source },
      db: args.db,
      file,
      storage: args.storage,
    });
  } catch (error) {
    if (error instanceof AttachmentSourceUnavailableError) {
      throw new AttachmentDownloadError(
        `${attachment.filename} is no longer available: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}
