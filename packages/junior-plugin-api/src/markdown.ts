/**
 * Read Markdown text with a Markdown parser. Use these helpers instead of
 * matching Markdown syntax with a regex: a regex misses nesting, escapes, and
 * code spans. `junior/no-regex-markdown` points here.
 */
import type { Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/** One node of a parsed Markdown tree. */
export type MarkdownNode = Nodes;

/**
 * Parse GitHub-flavored Markdown. Each node position holds offsets into
 * `text`, so a caller can slice the source of a node.
 */
export function parseMarkdown(text: string): Root {
  return fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

/**
 * Return the nodes of the given types in a Markdown tree, in text order. It
 * does not look inside a node that it returns.
 */
export function markdownNodes<Type extends MarkdownNode["type"]>(
  tree: MarkdownNode,
  types: readonly Type[],
): Extract<MarkdownNode, { type: Type }>[] {
  const found: Extract<MarkdownNode, { type: Type }>[] = [];
  const visit = (node: MarkdownNode) => {
    if (isOfType(node, types)) found.push(node);
    else if ("children" in node)
      for (const child of node.children) visit(child);
  };
  visit(tree);
  return found;
}

function isOfType<Type extends MarkdownNode["type"]>(
  node: MarkdownNode,
  types: readonly Type[],
): node is Extract<MarkdownNode, { type: Type }> {
  return types.some((type) => type === node.type);
}

/** What `markdownText` reads from a Markdown tree. */
export interface MarkdownTextOptions {
  /**
   * Leave out code blocks, images, and HTML, for a place that has room only
   * for prose. Inline code stays.
   */
  proseOnly?: boolean;
}

// Nodes whose children are inline text, so their parts join with no space.
const INLINE_PARENTS = new Set<MarkdownNode["type"]>([
  "delete",
  "emphasis",
  "heading",
  "link",
  "linkReference",
  "paragraph",
  "strong",
  "tableCell",
]);

const NON_PROSE = new Set<MarkdownNode["type"]>(["code", "html", "image"]);

/**
 * Return the readable text of a Markdown node without its syntax. Inline
 * parts join with no space, and blocks join with one space. An image gives
 * its alt text. The whitespace inside text stays as it is.
 */
export function markdownText(
  node: MarkdownNode,
  options: MarkdownTextOptions = {},
): string {
  if (options.proseOnly && NON_PROSE.has(node.type)) return "";
  if (node.type === "image") return node.alt ?? "";
  if (node.type === "break") return " ";
  if ("value" in node) return node.value;
  if (!("children" in node)) return "";
  return node.children
    .map((child) => markdownText(child, options))
    .join(INLINE_PARENTS.has(node.type) ? "" : " ");
}

/**
 * Return Markdown text as one plain line: the readable text of its tree with
 * each run of whitespace made one space.
 */
export function markdownPlainText(
  text: string,
  options: MarkdownTextOptions = {},
): string {
  return markdownText(parseMarkdown(text), options).replace(/\s+/g, " ").trim();
}
