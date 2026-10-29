import type { AttachmentStorageProvider } from "@/chat/config";
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
 * Create attachment storage for a configured provider.
 *
 * Runtime entry points pass the provider from chat config instead of calling
 * a provider adapter, so adding a provider only changes this switch.
 */
export function createAttachmentStorage(
  provider: AttachmentStorageProvider,
): AttachmentStorage {
  switch (provider) {
    case "vercel-blob":
      return createVercelAttachmentStorage();
  }
}
