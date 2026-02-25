import { NodeHtmlMarkdown } from "node-html-markdown";

const htmlToMarkdownConverter = new NodeHtmlMarkdown({
  bulletMarker: "-",
  codeBlockStyle: "fenced",
  ignore: ["script", "style", "noscript", "nav", "footer", "header", "aside"],
  maxConsecutiveNewlines: 2
});

function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
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

export function extractContent(body: string, contentType: string, maxChars: number): string {
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
      return truncateAtWordBoundary(normalizeWhitespace(normalizedBody), maxChars);
    }
  }

  return truncateAtWordBoundary(normalizeWhitespace(normalizedBody), maxChars);
}
