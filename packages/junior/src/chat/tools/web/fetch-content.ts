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

export interface WebFetchResponseContent {
  content: string;
  title?: string;
  truncated: boolean;
  extractedChars: number;
}

export type WebFetchResponse = {
  ok: true;
  status: "success";
  url: string;
  content: string;
  title?: string;
  content_type: string;
  source_bytes: number;
  extracted_chars: number;
  truncated: boolean;
} & Record<string, unknown>;

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateAtWordBoundary(
  text: string,
  maxChars: number,
): { content: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { content: text, truncated: false };
  }
  const shortened = text.slice(0, maxChars);
  const lastSpace = shortened.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.8) {
    return {
      content: `${shortened.slice(0, lastSpace).trimEnd()}...`,
      truncated: true,
    };
  }
  return { content: `${shortened.trimEnd()}...`, truncated: true };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = match ? normalizeWhitespace(decodeHtmlEntities(match[1])) : "";
  return title.length > 0 ? title : undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getBalancedElementHtml(args: {
  html: string;
  startIndex: number;
  tagName: string;
}): string | undefined {
  const tagPattern = new RegExp(
    `</?${escapeRegex(args.tagName)}\\b[^>]*>`,
    "gi",
  );
  tagPattern.lastIndex = args.startIndex;
  let depth = 0;
  for (const match of args.html.matchAll(tagPattern)) {
    const tag = match[0];
    if (tag.startsWith("</")) {
      depth -= 1;
      if (depth === 0) {
        return args.html.slice(args.startIndex, match.index + tag.length);
      }
      continue;
    }
    if (!tag.endsWith("/>")) {
      depth += 1;
    }
  }
  return undefined;
}

function findElementHtml(
  html: string,
  predicate: (tagName: string, tag: string) => boolean,
): string | undefined {
  const openingTagPattern = /<([a-z][\w:-]*)\b[^>]*>/gi;
  for (const match of html.matchAll(openingTagPattern)) {
    const tagName = match[1];
    if (!tagName || !predicate(tagName.toLowerCase(), match[0])) {
      continue;
    }
    const balanced = getBalancedElementHtml({
      html,
      startIndex: match.index,
      tagName,
    });
    if (balanced) {
      return balanced;
    }
  }
  return undefined;
}

function extractMainHtml(html: string): string {
  return (
    findElementHtml(html, (tagName) => tagName === "main") ??
    findElementHtml(html, (tagName) => tagName === "article") ??
    findElementHtml(html, (_tagName, tag) =>
      /\brole\s*=\s*(["'])main\1/i.test(tag),
    ) ??
    html
  );
}

/** Extract readable content and metadata from a fetched response body. */
export function extractContentDetails(
  body: string,
  contentType: string,
  maxChars: number,
): WebFetchResponseContent {
  const loweredContentType = contentType.toLowerCase();
  const normalizedBody = body.trim();

  if (loweredContentType.includes("html")) {
    try {
      const sourceHtml = extractMainHtml(normalizedBody);
      const markdown = htmlToMarkdownConverter.translate(sourceHtml);
      const normalizedMarkdown = normalizeWhitespace(markdown);
      const truncated = truncateAtWordBoundary(normalizedMarkdown, maxChars);
      return {
        content: truncated.content,
        title: extractTitle(normalizedBody),
        truncated: truncated.truncated,
        extractedChars: normalizedMarkdown.length,
      };
    } catch {
      // Fall back to plain text extraction below.
    }
  }

  if (loweredContentType.includes("json")) {
    try {
      const parsed = JSON.parse(normalizedBody);
      const formatted = JSON.stringify(parsed, null, 2);
      const truncated = truncateAtWordBoundary(formatted, maxChars);
      return {
        content: truncated.content,
        truncated: truncated.truncated,
        extractedChars: formatted.length,
      };
    } catch {
      const normalizedText = normalizeWhitespace(normalizedBody);
      const truncated = truncateAtWordBoundary(normalizedText, maxChars);
      return {
        content: truncated.content,
        truncated: truncated.truncated,
        extractedChars: normalizedText.length,
      };
    }
  }

  const normalizedText = normalizeWhitespace(normalizedBody);
  const truncated = truncateAtWordBoundary(normalizedText, maxChars);
  return {
    content: truncated.content,
    truncated: truncated.truncated,
    extractedChars: normalizedText.length,
  };
}

/** Extract readable content from a fetched response body, converting HTML to markdown. */
export function extractContent(
  body: string,
  contentType: string,
  maxChars: number,
): string {
  return extractContentDetails(body, contentType, maxChars).content;
}

// ---------------------------------------------------------------------------
// Response extraction
// ---------------------------------------------------------------------------

/** Extract text content from a web fetch response, validating content type and size. */
export async function extractWebFetchResponse(
  url: URL,
  response: Response,
  maxChars = DEFAULT_MAX_CHARS,
): Promise<WebFetchResponse> {
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
  const extracted = extractContentDetails(body, contentType, safeMaxChars);
  return {
    ok: true,
    status: "success",
    url: url.toString(),
    content: extracted.content,
    ...(extracted.title ? { title: extracted.title } : {}),
    content_type: contentType || "unknown",
    source_bytes: Buffer.byteLength(body, "utf8"),
    extracted_chars: extracted.extractedChars,
    truncated: extracted.truncated,
  };
}
