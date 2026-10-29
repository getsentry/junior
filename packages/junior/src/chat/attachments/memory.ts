import type { AttachmentStorage } from "./storage";

/** Attachment storage that keeps objects in process memory. */
export interface MemoryAttachmentStorage extends AttachmentStorage {
  /** Stored object bytes by key, so tests can check what was written. */
  readonly objects: ReadonlyMap<string, Buffer>;
}

/**
 * Store attachments in process memory, for tests.
 *
 * Objects are lost when the process stops, and each process has its own
 * copy. Do not use this provider for deployed apps.
 */
export function createMemoryAttachmentStorage(): MemoryAttachmentStorage {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    provider: "memory",
    async put(input) {
      objects.set(input.key, Buffer.from(input.body));
    },
    async get(key) {
      const body = objects.get(key);
      if (!body) return null;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(body));
          controller.close();
        },
      });
    },
    async delete(keys) {
      for (const key of keys) objects.delete(key);
    },
  };
}
