import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const EMPHASIS_MARKERS = ["*", "_", "~", "`"];

// The character classes of a regex source, such as `[*_~]`, without their
// brackets.
function characterClasses(pattern: string): string[] {
  const classes: string[] = [];
  let start: number | undefined;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      index += 1;
    } else if (char === "[" && start === undefined) {
      start = index + 1;
    } else if (char === "]" && start !== undefined) {
      classes.push(pattern.slice(start, index));
      start = undefined;
    }
  }
  return classes;
}

// A code fence, a link or image, or a class of three emphasis markers means
// the regex reads Markdown syntax.
function readsMarkdown(pattern: string): boolean {
  return (
    pattern.includes("```") ||
    pattern.includes("`{3}") ||
    pattern.includes("\\]\\(") ||
    characterClasses(pattern).some(
      (members) =>
        EMPHASIS_MARKERS.filter((marker) => members.includes(marker)).length >=
        3,
    )
  );
}

function stringValue(node: ESTree.Node | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

function isRegExpCall(node: ESTree.CallExpression | ESTree.NewExpression) {
  return node.callee.type === "Identifier" && node.callee.name === "RegExp";
}

/**
 * Ban regexes that read Markdown, such as ones that strip emphasis, code
 * fences, or links to get plain text. A regex misses nesting, escapes, and
 * code spans. Use the shared helpers in `@sentry/junior-plugin-api`:
 * `parseMarkdown`, `markdownNodes`, `markdownText`, and `markdownPlainText`.
 */
export const noRegexMarkdownRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Read Markdown with a Markdown parser, not a regex.",
    },
    messages: {
      noRegexMarkdown:
        "Do not match Markdown syntax with a regex. Use the Markdown helpers from `@sentry/junior-plugin-api`: `markdownPlainText` for plain text, or `parseMarkdown` with `markdownNodes` and `markdownText` to read nodes. Add a helper there when none fits.",
    },
    schema: [],
  },
  create(context) {
    const check = (node: ESTree.Node, pattern: string | undefined) => {
      if (pattern !== undefined && readsMarkdown(pattern)) {
        context.report({ node, messageId: "noRegexMarkdown" });
      }
    };
    const checkCall = (node: ESTree.CallExpression | ESTree.NewExpression) => {
      if (isRegExpCall(node)) check(node, stringValue(node.arguments[0]));
    };
    return {
      Literal(node) {
        if ("regex" in node && node.regex) check(node, node.regex.pattern);
      },
      CallExpression: checkCall,
      NewExpression: checkCall,
    };
  },
});
