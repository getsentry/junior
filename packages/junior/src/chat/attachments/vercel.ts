import { del, get, issueSignedToken, presignUrl, put } from "@vercel/blob";
import { rangeHeader, type AttachmentStorage } from "./storage";

// Headers that the Blob SDK sends with a presigned client `PUT`. The SDK has
// no helper that returns them, so they mirror `uploadPresigned` in
// `@vercel/blob/client`. Keep the API version in step with the SDK.
const BLOB_API_VERSION = "12";

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
    async createUploadTarget(input) {
      const limits = {
        allowedContentTypes: [input.contentType],
        maximumSizeInBytes: input.bytes,
        validUntil: input.expiresAtMs,
      };
      // The token allows one `put` of this key. It works with OIDC and with a
      // read-write token, like the other Blob calls here.
      const token = await issueSignedToken({
        ...limits,
        operations: ["put"],
        pathname: input.key,
      });
      const { presignedUrl } = await presignUrl(token, {
        ...limits,
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: false,
        operation: "put",
        pathname: input.key,
      });
      return {
        headers: {
          "x-api-version": BLOB_API_VERSION,
          "x-content-type": input.contentType,
          "x-vercel-blob-access": "private",
        },
        method: "PUT",
        url: presignedUrl,
      };
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
