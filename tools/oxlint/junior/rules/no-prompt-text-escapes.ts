import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { calledMethod, staticString } from "../prompt-tag-patterns.ts";

const ENTITY = /&(?:lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/i;
const ONLY_ENTITY = new RegExp(`^${ENTITY.source}$`, "i");
// The XML helpers that prompt text used before prompt-tags.ts owned it.
const REMOVED_HELPERS = new Set(["escapeXml", "escapeXmlText"]);
const XML_MODULE = /(?:^|\/)xml(?:\.[jt]s)?$/;

function importsRemovedHelper(node: ESTree.ImportDeclaration): boolean {
  return node.specifiers.some(
    (specifier) =>
      specifier.type === "ImportSpecifier" &&
      specifier.imported.type === "Identifier" &&
      REMOVED_HELPERS.has(specifier.imported.name),
  );
}

/**
 * Ban escape code for prompt text outside `@sentry/junior-plugin-api`
 * prompt-tags.ts. A second escape drifts from the first, and text that one
 * escape misses can end a tag that the other one fences.
 */
export const noPromptTextEscapesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Escape prompt text with the prompt-tags.ts helpers, not a local escape.",
    },
    messages: {
      localEscape:
        "Escape prompt text with `escapeTagText` or `escapeClosingTags` from `@sentry/junior-plugin-api`. HTML and Slack mrkdwn have their own escape modules.",
      removedHelper:
        "Prompt text no longer uses the XML helpers. Escape it with `escapeTagText` or `escapeClosingTags` from `@sentry/junior-plugin-api`.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const method = calledMethod(node);
        if (method !== "replace" && method !== "replaceAll") return;
        const replacement = staticString(node.arguments[1]);
        if (replacement !== undefined && ENTITY.test(replacement)) {
          context.report({ node, messageId: "localEscape" });
        }
      },
      // A character-to-entity map, such as `{ "<": "&lt;" }`.
      Property(node) {
        const value = staticString(node.value);
        if (value !== undefined && ONLY_ENTITY.test(value)) {
          context.report({ node, messageId: "localEscape" });
        }
      },
      ImportDeclaration(node) {
        if (XML_MODULE.test(node.source.value) || importsRemovedHelper(node)) {
          context.report({ node, messageId: "removedHelper" });
        }
      },
    };
  },
});
