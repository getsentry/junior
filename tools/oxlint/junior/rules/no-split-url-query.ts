import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

// String methods that cut a path or URL at its query separator.
const CUTTING_METHODS = new Set(["indexOf", "split"]);

function stringValue(node: ESTree.Node | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/**
 * Ban cutting a path or URL at `?` by hand. `parsePath` from react-router
 * and `new URL()` return the pathname, search, and hash, and handle a hash
 * or a missing query that a split gets wrong.
 */
export const noSplitUrlQueryRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Read the parts of a path with `parsePath` or `new URL()`, not by splitting on `?`.",
    },
    messages: {
      noSplitQuery:
        "Read a path's pathname and search with `parsePath` from react-router, or a URL's with `new URL()`. Do not split or search on `?`.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          !CUTTING_METHODS.has(callee.property.name)
        ) {
          return;
        }
        if (stringValue(node.arguments[0]) === "?") {
          context.report({ node, messageId: "noSplitQuery" });
        }
      },
    };
  },
});
