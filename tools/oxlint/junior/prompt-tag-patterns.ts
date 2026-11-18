import type { ESTree } from "@oxlint/plugins";

// Shared by the prompt tag rules. `@sentry/junior-plugin-api` prompt-tags.ts
// owns how model-read text writes, escapes, and reads tags; these patterns
// find code that does it another way.

const NAME = "[A-Za-z][\\w-]*";
const ATTRIBUTES = `(?:\\s+[a-z_][\\w-]*="[^"]*")*`;

const CLOSING_TAG = new RegExp(`(?:<|&lt;)/${NAME}(?:>|&gt;)`);
const EMPTY_TAG = new RegExp(`<${NAME}${ATTRIBUTES}\\s*/>`);
// An opening tag alone on a line of text with more lines. A lone `<id>` is a
// placeholder; a block that a string array joins also has its closing tag.
const OPENING_LINE = new RegExp(`^[ \\t]*<${NAME}${ATTRIBUTES}>[ \\t]*$`, "m");
// The start of an opening tag whose attribute values come from code.
const OPENING_WITH_ATTRIBUTE = new RegExp(
  `^[ \\t]*<${NAME}\\s+[a-z_][\\w-]*="`,
  "m",
);
/** Find hand-built prompt tag syntax in one piece of string text. */
export function findTagSyntax(text: string) {
  return (
    CLOSING_TAG.exec(text)?.[0] ??
    EMPTY_TAG.exec(text)?.[0] ??
    (text.includes("\n") ? OPENING_LINE.exec(text)?.[0].trim() : undefined) ??
    OPENING_WITH_ATTRIBUTE.exec(text)?.[0].trim()
  );
}

/**
 * Find a tag name that a template literal builds, as in `</${name}>` or
 * `<${TAG}>`. `<${url}|label>` is a Slack link, so an opening tag counts
 * only when the expression names a tag.
 */
export function findDynamicTag(
  text: string,
  expression: ESTree.Node | undefined,
) {
  if (text.endsWith("</")) return "</";
  if (!text.endsWith("<")) return undefined;
  const name =
    expression?.type === "Identifier"
      ? expression.name
      : expression?.type === "MemberExpression" &&
          expression.property.type === "Identifier"
        ? expression.property.name
        : "";
  return /tag/i.test(name) ? "<" : undefined;
}

// A tag name right after `<` or `</` in searched text, ended by `>`, space,
// or the end of the text. `<https://` and `<@U123>` are Slack syntax.
const SEARCHED_TAG = new RegExp(`</?${NAME}(?=[>\\s]|$)`);

/** Find a prompt tag in text that code searches for. */
export function findSearchedTag(text: string) {
  return SEARCHED_TAG.exec(text)?.[0];
}

// A tag name or a group of names after `<` or `<\/` in a regex source. A
// named group `(?<name>` and a back reference `\k<name>` are not tags.
const REGEX_TAG =
  /(?<!\(\?|\\k)<(?:\\?\/)?\??(?:[A-Za-z][\w-]*(?=>|\\[bs]|[\s[(|?)$])|\(\?:[A-Za-z])/;

/** Find a prompt tag that a regex source matches. */
export function findRegexTag(pattern: string) {
  return REGEX_TAG.exec(pattern)?.[0];
}

/** String methods that search text for a substring or a pattern. */
export const SEARCH_METHODS = new Set([
  "endsWith",
  "includes",
  "indexOf",
  "lastIndexOf",
  "match",
  "matchAll",
  "replace",
  "replaceAll",
  "search",
  "split",
  "startsWith",
]);

/** Text of a string literal or of a template literal with no expressions. */
export function staticString(
  node: ESTree.Node | null | undefined,
): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/** Method name of a call such as `text.includes(...)`. */
export function calledMethod(node: ESTree.CallExpression) {
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || callee.computed) return undefined;
  return callee.property.type === "Identifier"
    ? callee.property.name
    : undefined;
}
