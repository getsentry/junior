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
      // Bypass the CDN so a read shortly after a write for a fresh key cannot
      // observe a not-yet-propagated (empty/stale) cached response. See
      // https://vercel.com/changelog/vercel-blob-now-supports-consistent-reads-on-private-storage.
      const result = await get(key, { access: "private", useCache: false });
      return result?.statusCode === 200 ? result.stream : null;
    },
    async delete(keys) {
      if (keys.length === 0) return;
      await del(keys);
    },
  };
}
