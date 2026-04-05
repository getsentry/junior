import type { FormattedContent } from "chat";

interface AstNode {
  type: string;
  value?: string;
  url?: string;
  children?: AstNode[];
}

/** Extract plain text from a message AST, preserving hyperlink URLs as `[text](url)`. */
export function extractTextPreservingLinks(ast: FormattedContent): string {
  return visitNode(ast as AstNode).trim();
}

const BLOCK_TYPES = new Set([
  "root",
  "paragraph",
  "list",
  "listItem",
  "blockquote",
  "heading",
]);

function visitNode(node: AstNode): string {
  if (
    node.type === "text" ||
    node.type === "inlineCode" ||
    node.type === "code"
  )
    return node.value ?? "";
  if (node.type === "link") {
    const childText = (node.children ?? []).map(visitNode).join("");
    return childText === node.url
      ? node.url
      : `[${childText}](${node.url ?? ""})`;
  }
  const separator = BLOCK_TYPES.has(node.type) ? "\n" : "";
  return (node.children ?? []).map(visitNode).join(separator);
}
