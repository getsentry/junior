import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import {
  calledMethod,
  findRegexTag,
  findSearchedTag,
  SEARCH_METHODS,
  staticString,
} from "../prompt-tag-patterns.ts";

// Text that a search method looks for, with each part of a template literal
// that holds expressions. A part that ends in `<` builds the tag name.
function searchedTag(node: ESTree.Node | undefined) {
  const text = staticString(node);
  if (text !== undefined) return findSearchedTag(text);
  if (node?.type !== "TemplateLiteral") return undefined;
  for (const quasi of node.quasis.slice(0, -1)) {
    const part = quasi.value.cooked ?? quasi.value.raw;
    const tag = findSearchedTag(part) ?? /<\/?$/.exec(part)?.[0];
    if (tag !== undefined) return tag;
  }
  return undefined;
}

function isRegExpCall(node: ESTree.CallExpression | ESTree.NewExpression) {
  return node.callee.type === "Identifier" && node.callee.name === "RegExp";
}

/**
 * Ban regexes and substring searches that find prompt tags. `findTag`,
 * `readTag`, and `stripTags` from `@sentry/junior-plugin-api` read a tag only
 * at the start of a line, so a tag name inside quoted or escaped text is not
 * read as a block.
 */
export const noPromptTagMatchingRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Read prompt tags with `findTag`, `readTag`, or `stripTags`, not a regex or a substring search.",
    },
    messages: {
      tagMatch:
        "Read the prompt tag `{{tag}}` with `findTag`, `readTag`, `startsWithTag`, `mentionsTag`, or `stripTags` from `@sentry/junior-plugin-api`. They read a tag only at the start of a line.",
    },
  },
  create(context) {
    const report = (node: ESTree.Node, tag: string | undefined) => {
      if (tag !== undefined) {
        context.report({ node, messageId: "tagMatch", data: { tag } });
      }
    };
    const checkRegExpCall = (
      node: ESTree.CallExpression | ESTree.NewExpression,
    ) => {
      if (!isRegExpCall(node)) return;
      const pattern = staticString(node.arguments[0]);
      if (pattern !== undefined) report(node, findRegexTag(pattern));
    };
    return {
      Literal(node) {
        if ("regex" in node && node.regex) {
          report(node, findRegexTag(node.regex.pattern));
        }
      },
      NewExpression: checkRegExpCall,
      CallExpression(node) {
        checkRegExpCall(node);
        if (!SEARCH_METHODS.has(calledMethod(node) ?? "")) return;
        report(node, searchedTag(node.arguments[0]));
      },
    };
  },
});
