import { del, get, put } from "@vercel/blob";
import type { AttachmentStorage } from "./storage";

/** Store private conversation attachments in Vercel Blob. */
export function createVercelAttachmentStorage(): AttachmentStorage {
  return {
    provider: "vercel-blob",
    async put(input) {
      await put(input.key, input.body, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: input.contentType,
      });
    },
    async get(key) {
      const result = await get(key, { access: "private" });
      return result?.statusCode === 200 ? result.stream : null;
    },
    async delete(keys) {
      if (keys.length === 0) return;
      await del(keys);
    },
  };
}
