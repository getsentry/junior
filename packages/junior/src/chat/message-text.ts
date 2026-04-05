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

function visitNode(node: AstNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.type === "link") {
    const childText = visitChildren(node);
    return childText === node.url ? node.url : `[${childText}](${node.url})`;
  }
  if (node.type === "root") {
    return (node.children ?? []).map(visitNode).join("\n");
  }
  return visitChildren(node);
}

function visitChildren(node: AstNode): string {
  return (node.children ?? []).map(visitNode).join("");
}
