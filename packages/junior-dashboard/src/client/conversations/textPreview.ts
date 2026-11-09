import type { MessageAttachment } from "@sentry/junior/api/schema";
import type { BundledLanguage } from "shiki/bundle/web";

import { dashboardCodeLanguages } from "../code-languages";

/** Read at most this much of a file for its preview. */
export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

/** How a text preview shows a file: highlighted as a language, or plain. */
export type TextPreviewLanguage = BundledLanguage | "plain";

const EXTENSION_ALIASES: Record<string, BundledLanguage> = {
  htm: "html",
  md: "markdown",
  ndjson: "jsonl",
};

// Text files that have no dashboard grammar. Uploads of these files often
// have the type `application/octet-stream`, so the extension must decide.
const PLAIN_EXTENSIONS = new Set([
  "conf",
  "diff",
  "env",
  "go",
  "ini",
  "log",
  "patch",
  "rb",
  "rs",
  "text",
  "toml",
  "txt",
]);

const TEXT_APPLICATION_TYPES: Record<string, TextPreviewLanguage> = {
  "application/javascript": "javascript",
  "application/json": "json",
  "application/toml": "plain",
  "application/x-ndjson": "jsonl",
  "application/x-sh": "shellscript",
  "application/x-yaml": "yaml",
  "application/xml": "xml",
  "application/yaml": "yaml",
};

const TEXT_TYPES: Record<string, TextPreviewLanguage> = {
  "text/css": "css",
  "text/csv": "csv",
  "text/html": "html",
  "text/javascript": "javascript",
  "text/markdown": "markdown",
  "text/xml": "xml",
  "text/yaml": "yaml",
};

function extensionLanguage(filename: string): TextPreviewLanguage | undefined {
  // A dotfile such as `.env` has its name as its extension.
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return undefined;
  const extension = filename.slice(dot + 1).toLowerCase();
  if (PLAIN_EXTENSIONS.has(extension)) return "plain";
  const candidate = EXTENSION_ALIASES[extension] ?? extension;
  return Object.hasOwn(dashboardCodeLanguages, candidate)
    ? (candidate as BundledLanguage)
    : undefined;
}

function contentTypeLanguage(
  contentType: string,
): TextPreviewLanguage | undefined {
  const type = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (type in TEXT_APPLICATION_TYPES) return TEXT_APPLICATION_TYPES[type];
  if (!type.startsWith("text/")) return undefined;
  return TEXT_TYPES[type] ?? "plain";
}

/**
 * Choose how to preview a stored file as text, or return undefined when it
 * is not a text file. The file extension wins, because uploads often have a
 * generic content type.
 */
export function textPreviewLanguage(
  attachment: Pick<MessageAttachment, "contentType" | "filename">,
): TextPreviewLanguage | undefined {
  return (
    extensionLanguage(attachment.filename) ??
    contentTypeLanguage(attachment.contentType)
  );
}

/**
 * Decode the first bytes of a file as UTF-8 text. Return undefined when the
 * bytes hold a NUL byte, which text does not have.
 */
export function decodeTextPreview(
  bytes: Uint8Array,
  truncated: boolean,
): string | undefined {
  if (bytes.includes(0)) return undefined;
  // `stream` holds back a character that the byte limit cut in half.
  return new TextDecoder().decode(bytes, { stream: truncated });
}
