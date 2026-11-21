import { randomUUID } from "node:crypto";
import type { PluginDownloadUrls } from "@sentry/junior-plugin-api";
import { bufferBody, type AttachmentStorage } from "@/chat/attachments/storage";

// Long enough for an outside service to fetch a large file once. The URL
// stops working after this even when the copy is never deleted.
const DOWNLOAD_URL_TTL_MS = 5 * 60 * 1000;

/**
 * Give plugin tools short-lived download URLs for private copies of bytes.
 *
 * Returns undefined when the storage cannot sign reads, so the plugin never
 * gets a public link in their place.
 */
export function createPluginDownloadUrls(
  storage: AttachmentStorage | undefined,
  conversationId: string,
): PluginDownloadUrls | undefined {
  const sign = storage?.createDownloadUrl?.bind(storage);
  if (!storage || !sign) return undefined;
  return {
    async create({ body, contentType }) {
      const key = `conversations/${conversationId}/downloads/${randomUUID()}`;
      await storage.put({
        body: bufferBody(body),
        bytes: body.byteLength,
        contentType,
        key,
      });
      let url: string;
      try {
        url = await sign({
          expiresAtMs: Date.now() + DOWNLOAD_URL_TTL_MS,
          key,
        });
      } catch (error) {
        // The caller never gets a delete handle, so remove the copy here.
        // Best effort: the signing error is the failure that matters.
        await storage.delete([key]).catch(() => undefined);
        throw error;
      }
      return { delete: () => storage.delete([key]), url };
    },
  };
}
