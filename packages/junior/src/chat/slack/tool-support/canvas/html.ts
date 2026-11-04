import { NodeHtmlMarkdown } from "node-html-markdown";

// Slack serves canvas downloads as Quip HTML, with links as `<lnk href>`.
const canvasHtmlConverter = new NodeHtmlMarkdown(
  {
    bulletMarker: "-",
    codeBlockStyle: "fenced",
    maxConsecutiveNewlines: 2,
  },
  {
    lnk: ({ node }) => ({
      prefix: "[",
      postfix: `](${node.getAttribute("href") ?? ""})`,
    }),
  },
);

/**
 * Convert a downloaded canvas body to Markdown. Canvas writes take Markdown,
 * so an HTML body passed back unchanged renders as escaped HTML text.
 */
export function canvasBodyToMarkdown(body: string): string {
  if (!body.trimStart().startsWith("<")) {
    return body;
  }
  return canvasHtmlConverter.translate(body).trim();
}
