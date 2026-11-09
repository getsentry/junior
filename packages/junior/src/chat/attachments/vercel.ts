import { del, get, put } from "@vercel/blob";
import { rangeHeader, type AttachmentStorage } from "./storage";

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
    async get(key, range) {
      // Bypass the CDN so a read shortly after a write for a fresh key cannot
      // observe a not-yet-propagated (empty/stale) cached response. See
      // https://vercel.com/changelog/vercel-blob-now-supports-consistent-reads-on-private-storage.
      const result = await get(key, {
        access: "private",
        useCache: false,
        ...(range ? { headers: { range: rangeHeader(range) } } : undefined),
      });
      if (result?.statusCode !== 200) return null;
      // The SDK reports a 206 response as 200. Only `content-range` shows
      // that Blob sent the range and not the whole object.
      if (range && !result.headers.get("content-range")) {
        await result.stream.cancel();
        throw new Error("Vercel Blob get ignored the byte range");
      }
      return result.stream;
    },
    async delete(keys) {
      if (keys.length === 0) return;
      await del(keys);
    },
  };
}
