import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/** True for a `sql` tagged template whose text reads a table. */
function isTableStatement(node: ESTree.Node | undefined): boolean {
  if (node?.type !== "TaggedTemplateExpression") return false;
  if (node.tag.type !== "Identifier" || node.tag.name !== "sql") return false;
  return node.quasi.quasis.some((quasi) => /\bfrom\b/i.test(quasi.value.raw));
}

/**
 * Reject `<db>.execute(sql`...`)` statements that read a table. Builder
 * queries keep column types and follow schema renames. `sql` stays fine for
 * expressions inside a builder query, and for statements without a table,
 * such as advisory locks.
 */
export const noRawSqlQueriesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require the Drizzle query builder for queries that read a table.",
    },
    messages: {
      noRawSqlQueries:
        "Build table queries with the Drizzle query builder. Use `db.$with` for CTEs and `innerJoinLateral` or `leftJoinLateral` for lateral joins. Keep `sql` for expressions inside a builder query.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          callee.property.name === "execute" &&
          isTableStatement(node.arguments[0])
        ) {
          context.report({ node, messageId: "noRawSqlQueries" });
        }
      },
    };
  },
});
