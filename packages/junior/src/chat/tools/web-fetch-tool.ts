import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import {
  FETCH_TIMEOUT_MS,
  MAX_FETCH_BYTES,
  MAX_REDIRECTS,
} from "@/chat/tools/constants";
import {
  assertPublicUrl,
  fetchTextWithRedirects,
  withTimeout,
} from "@/chat/tools/network";
import type { ToolHooks } from "@/chat/tools/types";
import {
  extractWebFetchResponse,
  MAX_FETCH_CHARS,
} from "@/chat/tools/web-fetch";

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

function extractHttpStatusFromMessage(message: string): number | null {
  const match = message.match(/fetch failed:\s*(\d{3})/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createWebFetchTool(hooks: ToolHooks) {
  return tool({
    description:
      "Fetch and extract readable content from a specific URL. Use when you need details from a known page or document. Do not use for discovery when search is the first step.",
    inputSchema: Type.Object({
      url: Type.String({
        minLength: 1,
        description: "HTTP(S) URL to fetch.",
      }),
      max_chars: Type.Optional(
        Type.Integer({
          minimum: 500,
          maximum: MAX_FETCH_CHARS,
          description:
            "Optional maximum number of extracted characters to return.",
        }),
      ),
    }),
    execute: async ({ url, max_chars }) => {
      try {
        const safeUrl = await assertPublicUrl(url);
        const response = await withTimeout(
          fetchTextWithRedirects(safeUrl, MAX_REDIRECTS),
          FETCH_TIMEOUT_MS,
          "fetch",
        );
        const contentType = (
          response.headers.get("content-type") ?? ""
        ).toLowerCase();

        if (response.ok && contentType.startsWith("image/")) {
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.byteLength > MAX_FETCH_BYTES) {
            throw new Error("image response body too large");
          }

          const filename = filenameForUrl(
            safeUrl,
            contentType.split(";")[0] ?? "image/png",
          );
          hooks.onGeneratedFiles?.([
            {
              data: bytes,
              filename,
              mimeType: contentType.split(";")[0] ?? "application/octet-stream",
            },
          ]);

          return {
            ok: true,
            url: safeUrl.toString(),
            media_type: contentType,
            bytes: bytes.byteLength,
            delivery:
              "Fetched image will be attached to the Slack response as a file.",
          };
        }

        return await extractWebFetchResponse(safeUrl, response, max_chars);
      } catch (error) {
        const message = error instanceof Error ? error.message : "fetch failed";
        const status = extractHttpStatusFromMessage(message);
        const isClientError = status !== null && status >= 400 && status < 500;
        return {
          ok: false,
          url,
          error: message,
          status,
          retryable: !isClientError,
        };
      }
    },
  });
}
