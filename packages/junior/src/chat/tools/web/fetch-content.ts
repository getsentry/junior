import { NodeHtmlMarkdown } from "node-html-markdown";
import { MAX_FETCH_BYTES } from "@/chat/tools/web/constants";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { readResponseBytes } from "@/chat/tools/web/network";

// ---------------------------------------------------------------------------
// Content extraction (HTML → markdown, JSON formatting)
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
}

export type WebFetchResponse = {
  url: string;
  content: string;
  title?: string;
  content_type: string;
  source_bytes: number;
  /** The page was over the byte limit, so the content stops early. */
  truncated: boolean;
} & Record<string, unknown>;

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  const title =
    match?.[1] !== undefined
      ? normalizeWhitespace(decodeHtmlEntities(match[1]))
      : "";
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
): WebFetchResponseContent {
  const loweredContentType = contentType.toLowerCase();
  const normalizedBody = body.trim();

  if (loweredContentType.includes("html")) {
    try {
      const sourceHtml = extractMainHtml(normalizedBody);
      const markdown = htmlToMarkdownConverter.translate(sourceHtml);
      return {
        content: normalizeWhitespace(markdown),
        title: extractTitle(normalizedBody),
      };
    } catch {
      // Fall back to plain text extraction below.
    }
  }

  if (loweredContentType.includes("json")) {
    try {
      return {
        content: JSON.stringify(JSON.parse(normalizedBody), null, 2),
      };
    } catch {
      // Fall back to plain text extraction below.
    }
  }

  return { content: normalizeWhitespace(normalizedBody) };
}

/** Extract readable content from a fetched response body, converting HTML to markdown. */
export function extractContent(body: string, contentType: string): string {
  return extractContentDetails(body, contentType).content;
}

// ---------------------------------------------------------------------------
// Response extraction
// ---------------------------------------------------------------------------

/**
 * Extract text content from a web fetch response, validating content type and
 * size. The tool pipeline cuts long content for the model.
 */
export async function extractWebFetchResponse(
  url: URL,
  response: Response,
): Promise<WebFetchResponse> {
  if (!response.ok) {
    await response.body?.cancel();
    const message = `fetch failed: ${response.status}`;
    // Client-side misses are model-repairable. Upstream 5xx stays a system error.
    if (response.status >= 400 && response.status < 500) {
      throw new ToolInputError(message);
    }
    throw new Error(message);
  }

  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  if (
    !contentType.includes("text/") &&
    !contentType.includes("json") &&
    !contentType.includes("xml")
  ) {
    await response.body?.cancel();
    throw new ToolInputError(
      `unsupported content type: ${contentType || "unknown"}`,
    );
  }

  // A page over the byte limit is cut, not rejected. Extraction keeps what was
  // read, and the result says that the page stops early.
  const { bytes, truncated: sourceTruncated } = await readResponseBytes(
    response,
    MAX_FETCH_BYTES,
  );
  const body = new TextDecoder().decode(bytes);
  const extracted = extractContentDetails(body, contentType);
  return {
    url: url.toString(),
    content: extracted.content,
    ...(extracted.title ? { title: extracted.title } : undefined),
    content_type: contentType || "unknown",
    source_bytes: bytes.byteLength,
    truncated: sourceTruncated,
  };
}
