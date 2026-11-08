import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function memberName(node: ESTree.Node): string | null {
  if (node.type !== "MemberExpression" || node.computed) return null;
  return node.property.type === "Identifier" ? node.property.name : null;
}

/** True for `egress.fetch` and `<anything>.egress.fetch`. */
function isEgressFetch(callee: ESTree.Node): boolean {
  if (callee.type !== "MemberExpression" || memberName(callee) !== "fetch") {
    return false;
  }
  const target = callee.object;
  return (
    (target.type === "Identifier" && target.name === "egress") ||
    memberName(target) === "egress"
  );
}

/**
 * Require GitHub plugin code to call GitHub through `githubApi`, so every
 * request gets the same headers, body parsing, and error text.
 */
export const useGitHubApiRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require GitHub plugin code to call GitHub through githubApi instead of egress.fetch.",
    },
    messages: {
      useGitHubApi:
        "Call GitHub with `githubApi` from `tool-support/github-api.ts`. It sends the request through host egress with the shared headers, parses the body, and pairs with `githubErrorMessage`.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isEgressFetch(node.callee)) {
          context.report({ node, messageId: "useGitHubApi" });
        }
      },
    };
  },
});
