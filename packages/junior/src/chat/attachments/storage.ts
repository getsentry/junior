import { createVercelAttachmentStorage } from "./vercel";

/** Bytes and metadata written to attachment object storage. */
export interface AttachmentWrite {
  body: Buffer;
  contentType: string;
  key: string;
}

/** Small object-storage capability used by conversation attachments. */
export interface AttachmentStorage {
  readonly provider: string;
  put(input: AttachmentWrite): Promise<void>;
  /** Return live object bytes, or null when the key is missing. */
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(keys: string[]): Promise<void>;
}

/**
 * Create the attachment storage for this deployment.
 *
 * Runtime entry points call this instead of a provider adapter, so the
 * provider choice stays in one place.
 */
export function createAttachmentStorage(): AttachmentStorage {
  return createVercelAttachmentStorage();
}
