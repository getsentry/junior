import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

const PREVIEW_MAX_CHARS = 180;

// Nodes whose children are inline text, so their parts join with no space.
const INLINE_PARENTS = new Set<Nodes["type"]>([
  "delete",
  "emphasis",
  "heading",
  "link",
  "linkReference",
  "paragraph",
  "strong",
  "tableCell",
]);

// The readable text of a node. A notification has no room for code blocks,
// images, or HTML, so they drop out.
function plainText(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "break") return " ";
  if (!("children" in node)) return "";
  return node.children
    .map((child) => plainText(child))
    .join(INLINE_PARENTS.has(node.type) ? "" : " ");
}

/** Turn Markdown text into one short plain line for a notification. */
export function notificationPreview(text: string): string {
  const plain = plainText(
    fromMarkdown(text, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }),
  )
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > PREVIEW_MAX_CHARS
    ? `${plain.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`
    : plain;
}
