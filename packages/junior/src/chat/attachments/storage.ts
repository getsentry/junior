import { getChatConfig } from "@/chat/config";
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

/** Inclusive byte offsets inside one stored object. */
export interface ByteRange {
  start: number;
  end: number;
}

/** Build the HTTP `Range` request header value for one byte range. */
export function rangeHeader(range: ByteRange): string {
  return `bytes=${range.start}-${range.end}`;
}

/** Small object-storage capability used by conversation attachments. */
export interface AttachmentStorage {
  readonly provider: string;
  put(input: AttachmentWrite): Promise<void>;
  /**
   * Return live object bytes, or null when the key is missing.
   *
   * With a range, return only those bytes. The caller checks the range
   * against the object size first.
   */
  get(
    key: string,
    range?: ByteRange,
  ): Promise<ReadableStream<Uint8Array> | null>;
  delete(keys: string[]): Promise<void>;
}

/**
 * Return attachment storage for the configured provider.
 *
 * Callers do not choose a provider. Chat config decides it.
 */
export function getAttachmentStorage(): AttachmentStorage {
  return createAttachmentStorage(getChatConfig().attachmentStorage);
}

/**
 * Create attachment storage for one provider config.
 *
 * Runtime code uses `getAttachmentStorage()`. Call this only to test a
 * provider adapter with its own config.
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
    default:
      throw new Error(
        `Unsupported attachment storage provider: ${String((config as { provider: unknown }).provider)}`,
      );
  }
}
