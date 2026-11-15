import { getChatConfig } from "@/chat/config";
import type { AttachmentStorageConfig } from "./config";
import { createMemoryAttachmentStorage } from "./memory";
import { createS3AttachmentStorage } from "./s3";
import { createVercelAttachmentStorage } from "./vercel";

/**
 * One object write. `body` streams, so a large file never sits in memory.
 * `bytes` is the exact body length: S3 needs it before the body starts.
 */
export interface AttachmentWrite {
  body: ReadableStream<Uint8Array>;
  bytes: number;
  contentType: string;
  key: string;
}

/** Stream bytes that are already in memory to `AttachmentStorage.put`. */
export function bufferBody(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
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

/** One object that a browser may write, and how long it may try. */
export interface AttachmentUploadRequest {
  bytes: number;
  contentType: string;
  expiresAtMs: number;
  key: string;
}

/** Signed HTTP request that writes one object from a browser. */
export interface AttachmentUploadTarget {
  headers: Record<string, string>;
  method: "PUT";
  url: string;
}

/** Small object-storage capability used by conversation attachments. */
export interface AttachmentStorage {
  readonly provider: string;
  put(input: AttachmentWrite): Promise<void>;
  /**
   * Sign a browser write of one key, limited to its size and type.
   *
   * A provider without browser writes omits this. The API then takes the
   * bytes itself, so the host request size limit applies.
   */
  createUploadTarget?(
    input: AttachmentUploadRequest,
  ): Promise<AttachmentUploadTarget>;
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
