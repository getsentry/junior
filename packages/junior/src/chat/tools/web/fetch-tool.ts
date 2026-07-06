import { z } from "zod";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import {
  FETCH_TIMEOUT_MS,
  MAX_FETCH_BYTES,
  MAX_REDIRECTS,
} from "@/chat/tools/web/constants";
import {
  assertPublicUrl,
  fetchTextWithRedirects,
  withTimeout,
} from "@/chat/tools/web/network";
import type { ToolHooks } from "@/chat/tools/types";
import {
  extractWebFetchResponse,
  MAX_FETCH_CHARS,
} from "@/chat/tools/web/fetch-content";

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

/** Create the fetch tool with delivery guidance scoped to active file-send capability. */
export function createWebFetchTool(
  hooks: ToolHooks,
  options: { canSendFilesToActiveConversation?: boolean } = {},
) {
  const override = hooks.toolOverrides?.webFetch;
  return zodTool({
    description:
      "Fetch and extract readable content from a specific URL. Use when you need details from a known page or document. Do not use for discovery when search is the first step.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      url: z.string().min(1).describe("HTTP(S) URL to fetch."),
      max_chars: z.coerce
        .number()
        .int()
        .min(500)
        .max(MAX_FETCH_CHARS)
        .describe("Optional maximum number of extracted characters to return.")
        .optional(),
    }),
    outputSchema: juniorToolResultSchema,
    execute: async ({ url, max_chars }) => {
      if (override?.execute) {
        return override.execute({ url, max_chars });
      }

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
          const files = [
            {
              data: bytes,
              filename,
              mimeType: contentType.split(";")[0] ?? "application/octet-stream",
            },
          ];
          const artifactRefs = hooks.writeGeneratedArtifacts
            ? await hooks.writeGeneratedArtifacts(files)
            : [];

          return {
            ok: true,
            status: "success" as const,
            url: safeUrl.toString(),
            media_type: contentType,
            bytes: bytes.byteLength,
            images: artifactRefs.map((artifact) => ({
              filename: artifact.filename,
              path: artifact.path,
              attachment_path: artifact.path,
              media_type: artifact.mimeType,
              bytes: artifact.bytes,
            })),
            delivery:
              artifactRefs.length > 0
                ? options.canSendFilesToActiveConversation
                  ? "Fetched image was written to a sandbox path. Use sendMessage to share or attach the image in the active conversation."
                  : "Fetched image was written to a sandbox path, but this runtime has no file-send tool for the active conversation."
                : "Fetched image bytes are available only in this tool result; this runtime has no file-send tool for the active conversation.",
          };
        }

        return await extractWebFetchResponse(safeUrl, response, max_chars);
      } catch (error) {
        const message = error instanceof Error ? error.message : "fetch failed";
        const status = extractHttpStatusFromMessage(message);
        const isClientError = status !== null && status >= 400 && status < 500;
        return {
          ok: false,
          status: "error" as const,
          url,
          error: message,
          http_status: status,
          retryable: !isClientError,
        };
      }
    },
  });
}
