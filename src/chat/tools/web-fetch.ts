import { tool } from "ai";
import { z } from "zod";
import { FETCH_TIMEOUT_MS, MAX_FETCH_BYTES, MAX_REDIRECTS } from "@/chat/tools/constants";
import { assertPublicUrl, fetchTextWithRedirects, withTimeout } from "@/chat/tools/network";
import type { ToolHooks } from "@/chat/tools/types";
import { webFetch, MAX_FETCH_CHARS } from "@/chat/tools/web_fetch";

function extensionForMediaType(mediaType: string): string {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/gif") return "gif";
  return "bin";
}

function filenameForUrl(url: URL, mediaType: string): string {
  const fromPath = url.pathname.split("/").filter(Boolean).pop();
  if (fromPath && fromPath.includes(".")) return fromPath;
  return `fetched-file.${extensionForMediaType(mediaType)}`;
}

export function createWebFetchTool(hooks: ToolHooks) {
  return tool({
    description: "Fetch and extract readable text from a URL.",
    inputSchema: z.object({
      url: z
        .string()
        .url()
        .describe("HTTP(S) URL to fetch."),
      max_chars: z
        .number()
        .int()
        .min(500)
        .max(MAX_FETCH_CHARS)
        .optional()
        .describe("Optional maximum number of extracted characters to return.")
    }),
    execute: async ({ url, max_chars }) => {
      try {
        const safeUrl = await assertPublicUrl(url);
        const response = await withTimeout(fetchTextWithRedirects(safeUrl, MAX_REDIRECTS), FETCH_TIMEOUT_MS, "fetch");
        const contentType = (response.headers.get("content-type") ?? "").toLowerCase();

        if (response.ok && contentType.startsWith("image/")) {
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.byteLength > MAX_FETCH_BYTES) {
            throw new Error("image response body too large");
          }

          const filename = filenameForUrl(safeUrl, contentType.split(";")[0] ?? "image/png");
          hooks.onGeneratedFiles?.([
            {
              data: bytes,
              filename,
              mimeType: contentType.split(";")[0] ?? "application/octet-stream"
            }
          ]);

          return {
            ok: true,
            url: safeUrl.toString(),
            media_type: contentType,
            bytes: bytes.byteLength,
            delivery: "Fetched image will be attached to the Slack response as a file."
          };
        }

        return await webFetch(url, max_chars);
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : "fetch failed");
      }
    }
  });
}
