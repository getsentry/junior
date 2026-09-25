import type { AttachmentStorage } from "@/chat/attachments/storage";

/** In-memory attachment object storage for eval agent runs. */
export function createMemoryAttachmentStorage(): AttachmentStorage {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  return {
    provider: "eval",
    async put(input) {
      objects.set(input.key, {
        body: Buffer.from(input.body),
        contentType: input.contentType,
      });
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(object.body);
          controller.close();
        },
      });
    },
    async delete(keys) {
      for (const key of keys) objects.delete(key);
    },
  };
}
