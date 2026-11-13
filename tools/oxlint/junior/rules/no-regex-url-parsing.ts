import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

// A scheme separator or an `http`/`https` scheme in a regex source means the
// regex reads a URL.
function readsUrl(pattern: string): boolean {
  return (
    pattern.includes("://") ||
    pattern.includes(":\\/\\/") ||
    pattern.includes("https?:")
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
 * Ban regexes that read one URL. `new URL()`, `URL.canParse()`, and
 * `URLPattern` follow the URL standard; a regex misses its edge cases. A
 * global (`g`) regex that finds URLs in free text is allowed.
 */
export const noRegexUrlParsingRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Read URLs with `URL`, `URL.canParse`, or `URLPattern`, not a regex.",
    },
    messages: {
      noRegexUrl:
        "Read a URL with `new URL()`, `URL.canParse()`, or `URLPattern`, and check its parts. To test a scheme prefix, use `startsWith`. Only a global regex that finds URLs in free text may match `://`.",
    },
  },
  create(context) {
    const check = (
      node: ESTree.Node,
      pattern: string | undefined,
      flags = "",
    ) => {
      if (pattern !== undefined && !flags.includes("g") && readsUrl(pattern)) {
        context.report({ node, messageId: "noRegexUrl" });
      }
    };
    const checkCall = (node: ESTree.CallExpression | ESTree.NewExpression) => {
      if (!isRegExpCall(node)) return;
      check(
        node,
        stringValue(node.arguments[0]),
        stringValue(node.arguments[1]),
      );
    };
    return {
      Literal(node) {
        if ("regex" in node && node.regex) {
          check(node, node.regex.pattern, node.regex.flags);
        }
      },
      CallExpression: checkCall,
      NewExpression: checkCall,
    };
  },
});
