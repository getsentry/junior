import { validate } from "@octokit/graphql-schema";
import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/** Return the text of a string literal or a template without expressions. */
function staticText(node: ESTree.Node | undefined): string | null {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** Return GitHub's errors for one document, or its syntax error. */
function schemaErrors(document: string): string[] {
  try {
    return validate(document).map((error) => error.message);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/**
 * Validate each `githubGraphql(...)` document against GitHub's public
 * schema, so a bad field fails lint instead of a GitHub request. The
 * document must be static text, so lint sees what GitHub receives.
 */
export const githubGraphqlSchemaRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Validate githubGraphql documents against GitHub's GraphQL schema.",
    },
    messages: {
      staticDocument:
        "Pass `githubGraphql` one string or template without expressions. Lint validates only static documents against GitHub's schema.",
      invalidDocument:
        "GitHub's GraphQL schema rejects this document: {{error}}",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type !== "Identifier" ||
          node.callee.name !== "githubGraphql"
        ) {
          return;
        }
        const [argument] = node.arguments;
        const document = staticText(argument);
        if (
          argument === undefined ||
          document === null ||
          node.arguments.length !== 1
        ) {
          context.report({ node, messageId: "staticDocument" });
          return;
        }
        for (const error of schemaErrors(document)) {
          context.report({
            node: argument,
            messageId: "invalidDocument",
            data: { error },
          });
        }
      },
    };
  },
});
