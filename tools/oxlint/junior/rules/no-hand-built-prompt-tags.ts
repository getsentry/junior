import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import {
  calledMethod,
  findDynamicTag,
  findTagSyntax,
  SEARCH_METHODS,
} from "../prompt-tag-patterns.ts";

// The text that a search method looks for belongs to
// `no-prompt-tag-matching`, which reports it once.
function isSearchedText(node: ESTree.Node): boolean {
  const parent = node.parent;
  return (
    parent?.type === "CallExpression" &&
    parent.arguments[0] === node &&
    SEARCH_METHODS.has(calledMethod(parent) ?? "")
  );
}

/**
 * Ban prompt tags that code writes by hand. `renderTag`, `renderInlineTag`,
 * and `renderEmptyTag` from `@sentry/junior-plugin-api` write every tag, so
 * the tag format and its escape stay in one place.
 */
export const noHandBuiltPromptTagsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Write prompt tags with `renderTag`, not string text.",
    },
    messages: {
      handBuiltTag:
        "Write the prompt tag `{{tag}}` with `renderTag`, `renderInlineTag`, or `renderEmptyTag` from `@sentry/junior-plugin-api`, so one module owns the tag format and its escape.",
    },
  },
  create(context) {
    const report = (node: ESTree.Node, tag: string | undefined) => {
      if (tag !== undefined) {
        context.report({ node, messageId: "handBuiltTag", data: { tag } });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === "string" && !isSearchedText(node)) {
          report(node, findTagSyntax(node.value));
        }
      },
      TemplateLiteral(node) {
        if (isSearchedText(node)) return;
        for (const [index, quasi] of node.quasis.entries()) {
          const text = quasi.value.cooked ?? quasi.value.raw;
          report(
            quasi,
            findTagSyntax(text) ??
              findDynamicTag(text, node.expressions[index]),
          );
        }
      },
    };
  },
});
