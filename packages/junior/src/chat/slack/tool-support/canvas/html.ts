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
export function canvasBodyToMarkdown(body: string, title?: string): string {
  if (!body.trimStart().startsWith("<")) {
    return body;
  }
  const markdown = canvasHtmlConverter.translate(body).trim();
  // The export starts with the canvas title as an `h1`. Slack keeps that
  // heading across a body replace, so writing it back would show it twice.
  const titleHeading = title ? `# ${title}` : undefined;
  if (titleHeading && markdown.split("\n", 1)[0] === titleHeading) {
    return markdown.slice(titleHeading.length).trimStart();
  }
  return markdown;
}
