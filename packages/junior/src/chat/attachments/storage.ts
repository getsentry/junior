import type { AttachmentStorageConfig } from "./config";
import { createMemoryAttachmentStorage } from "./memory";
import { createS3AttachmentStorage } from "./s3";
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
 * Create attachment storage for the configured provider.
 *
 * Runtime entry points pass `attachmentStorage` from chat config instead of
 * calling a provider adapter, so adding a provider only changes this switch.
 */
export function createAttachmentStorage(
  config: AttachmentStorageConfig,
): AttachmentStorage {
  switch (config.provider) {
    case "vercel-blob":
      return createVercelAttachmentStorage();
    case "s3":
      return createS3AttachmentStorage(config.s3);
    case "memory":
      return createMemoryAttachmentStorage();
  }
}
