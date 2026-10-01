import type { AttachmentStorage } from "@/chat/attachments/storage";

/** Keep attachment bytes in memory while exercising the real SQL store. */
export function memoryAttachmentStorage(): AttachmentStorage & {
  objects: Map<string, { body: Buffer; contentType: string }>;
} {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  return {
    objects,
    provider: "test",
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
