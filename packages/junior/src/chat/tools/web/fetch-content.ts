import { NodeHtmlMarkdown } from "node-html-markdown";
import {
  DEFAULT_MAX_CHARS,
  FETCH_TIMEOUT_MS,
  MAX_FETCH_BYTES,
  MAX_FETCH_CHARS,
} from "@/chat/tools/web/constants";
import { readResponseBody, withTimeout } from "@/chat/tools/web/network";

export { MAX_FETCH_CHARS };

// ---------------------------------------------------------------------------
// Content extraction (HTML → markdown, JSON formatting, truncation)
// ---------------------------------------------------------------------------

const htmlToMarkdownConverter = new NodeHtmlMarkdown({
  bulletMarker: "-",
  codeBlockStyle: "fenced",
  ignore: ["script", "style", "noscript", "nav", "footer", "header", "aside"],
  maxConsecutiveNewlines: 2,
});

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const shortened = text.slice(0, maxChars);
  const lastSpace = shortened.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.8) {
    return `${shortened.slice(0, lastSpace).trimEnd()}...`;
  }
  return `${shortened.trimEnd()}...`;
}

/** Extract readable content from a fetched response body, converting HTML to markdown. */
export function extractContent(
  body: string,
  contentType: string,
  maxChars: number,
): string {
  const loweredContentType = contentType.toLowerCase();
  const normalizedBody = body.trim();

  if (loweredContentType.includes("html")) {
    try {
      const markdown = htmlToMarkdownConverter.translate(normalizedBody);
      return truncateAtWordBoundary(normalizeWhitespace(markdown), maxChars);
    } catch {
      // Fall back to plain text extraction below.
    }
  }

  if (loweredContentType.includes("json")) {
    try {
      const parsed = JSON.parse(normalizedBody);
      return truncateAtWordBoundary(JSON.stringify(parsed, null, 2), maxChars);
    } catch {
      return truncateAtWordBoundary(
        normalizeWhitespace(normalizedBody),
        maxChars,
      );
    }
  }

  return truncateAtWordBoundary(normalizeWhitespace(normalizedBody), maxChars);
}

// ---------------------------------------------------------------------------
// Response extraction
// ---------------------------------------------------------------------------

/** Extract text content from a web fetch response, validating content type and size. */
export async function extractWebFetchResponse(
  url: URL,
  response: Response,
  maxChars = DEFAULT_MAX_CHARS,
): Promise<{ url: string; content: string }> {
  const safeMaxChars = Math.max(500, Math.min(maxChars, MAX_FETCH_CHARS));

  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status}`);
  }

  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  if (
    !contentType.includes("text/") &&
    !contentType.includes("json") &&
    !contentType.includes("xml")
  ) {
    throw new Error(`unsupported content type: ${contentType || "unknown"}`);
  }

  const body = await withTimeout(
    readResponseBody(response, MAX_FETCH_BYTES),
    FETCH_TIMEOUT_MS,
    "read",
  );
  const text = extractContent(body, contentType, safeMaxChars);
  return { url: url.toString(), content: text };
}
