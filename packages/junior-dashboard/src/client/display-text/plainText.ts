import type { ActorIdentity } from "@sentry/junior/api/schema";
import type { Nodes } from "mdast";

import { plainTextTokens } from "./mentions";
import { SLACK_LINK_RE } from "./links";
import { parseMarkdown } from "../markdownTree";

/**
 * Return display text as one plain string for places that cannot hold
 * markup, such as a `title` attribute. It shows the same names and emoji as
 * `DisplayText`, without the Markdown syntax.
 */
export function displayPlainText(
  text: string,
  mentions: readonly ActorIdentity[] = [],
): string {
  return plainTextTokens(stripMarkdown(text), mentions);
}

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

// The text of a node without its Markdown syntax. Code keeps its text, and
// an image shows its alt text.
function markdownText(node: Nodes): string {
  if (node.type === "image") return node.alt ?? "";
  if ("value" in node) return node.value;
  if (!("children" in node)) return node.type === "break" ? " " : "";
  return node.children
    .map(markdownText)
    .join(INLINE_PARENTS.has(node.type) ? "" : " ");
}

function stripMarkdown(text: string): string {
  const markdown = text.replace(
    SLACK_LINK_RE,
    (_, url: string, label?: string) => (label?.trim() ? label.trim() : url),
  );
  return markdownText(parseMarkdown(markdown)).replace(/\s+/g, " ").trim();
}
