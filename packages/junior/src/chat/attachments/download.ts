import { MAX_ATTACHMENT_BYTES } from "./input";
import {
  AttachmentSourceUnavailableError,
  type ReadAttachmentSource,
} from "./source";
import type { AttachmentStorage } from "./storage";
import type { AttachmentRecord } from "./store";

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
 * Find where the bytes of one attachment row are, without reading them.
 *
 * A stored file reads from storage. A large Slack file is never stored, so
 * each `open` downloads it from its source. The source reports the current
 * size, and the size check runs before any download. Errors that the person
 * should see are `AttachmentDownloadError`, from here or from `open`.
 *
 * The row must come from a lookup scoped to the caller's conversation. The
 * source id comes from that row only, never from a request.
 */
export async function readAttachmentContent(args: {
  attachment: AttachmentRecord;
  readAttachmentSource?: ReadAttachmentSource;
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
  const { source } = attachment;
  if (!source || !args.readAttachmentSource) {
    throw new AttachmentDownloadError(
      "Attachment cannot be downloaded from this conversation.",
    );
  }
  const unavailable = (error: unknown) =>
    error instanceof AttachmentSourceUnavailableError
      ? new AttachmentDownloadError(
          `${attachment.filename} is no longer available: ${error.message}`,
          { cause: error },
        )
      : error;
  let file;
  try {
    file = await args.readAttachmentSource(source);
  } catch (error) {
    throw unavailable(error);
  }
  if (file.bytes > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentDownloadError(ATTACHMENT_TOO_LARGE_MESSAGE);
  }
  return {
    bytes: file.bytes,
    open: async () => {
      try {
        return await file.open();
      } catch (error) {
        throw unavailable(error);
      }
    },
  };
}
