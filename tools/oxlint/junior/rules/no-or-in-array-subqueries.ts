import { defineRule } from "@oxlint/plugins";

import type { Context, ESTree, Scope } from "@oxlint/plugins";

const selectMethods = new Set(["select", "selectDistinct", "selectDistinctOn"]);

/** Find the `const` initializer that an identifier names, if it has one. */
function constInit(
  context: Context,
  node: ESTree.Node,
  name: string,
): ESTree.Node | undefined {
  for (
    let scope: Scope | null = context.sourceCode.getScope(node);
    scope;
    scope = scope.upper
  ) {
    const variable = scope.set.get(name);
    if (!variable) continue;
    const [only, ...rest] = variable.defs;
    if (
      rest.length > 0 ||
      only?.type !== "Variable" ||
      only.parent?.type !== "VariableDeclaration" ||
      only.parent.kind !== "const" ||
      only.node.type !== "VariableDeclarator"
    ) {
      return undefined;
    }
    return only.node.init ?? undefined;
  }
  return undefined;
}

/**
 * Say whether an expression is a query builder that is not awaited: a call
 * chain that starts with `.select(...)`, such as `db.select(...).from(t)`,
 * or a `const` set to one. A parameter or a function result is not known
 * without types, so it does not count.
 */
function isSubquery(
  context: Context,
  node: ESTree.Node | null | undefined,
  seen: Set<ESTree.Node> = new Set(),
): boolean {
  if (!node || seen.has(node)) return false;
  seen.add(node);
  switch (node.type) {
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
      return isSubquery(context, node.expression, seen);
    case "ConditionalExpression":
      return (
        isSubquery(context, node.consequent, seen) ||
        isSubquery(context, node.alternate, seen)
      );
    case "Identifier":
      return isSubquery(context, constInit(context, node, node.name), seen);
    case "CallExpression": {
      const callee = node.callee;
      if (callee.type !== "MemberExpression" || callee.computed) return false;
      if (
        callee.property.type === "Identifier" &&
        selectMethods.has(callee.property.name)
      ) {
        return true;
      }
      return isSubquery(context, callee.object, seen);
    }
    default:
      return false;
  }
}

/** Say whether a node calls the function with this name, like `or(...)`. */
function isCallTo(
  node: ESTree.Node | null | undefined,
  name: string,
): node is ESTree.CallExpression {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === name
  );
}

/** Count the `inArray(column, subquery)` terms of an `or`, inside `and` too. */
function countSubqueryTerms(context: Context, terms: ESTree.Node[]): number {
  let count = 0;
  for (const term of terms) {
    if (isCallTo(term, "inArray") && isSubquery(context, term.arguments[1])) {
      count += 1;
    } else if (isCallTo(term, "and")) {
      count += countSubqueryTerms(context, term.arguments);
    }
  }
  return count;
}

/**
 * Reject an `or(...)` with two or more `inArray(column, subquery)` terms.
 * Postgres cannot turn `IN (subquery)` under `OR` into a join, so it can
 * check each row of the table. `= any(array(subquery))` runs the subquery
 * once and lets each column use its index.
 */
export const noOrInArraySubqueriesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Reject `or()` over several `inArray(column, subquery)` filters.",
    },
    messages: {
      noOrInArraySubqueries:
        "Postgres can scan the whole table for `or()` over `inArray(column, subquery)` filters. Match each column with sql`${column} = any(array(${subquery}))` instead, like `inParticipantRoot` in packages/junior/src/api/conversations/membership.ts.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          isCallTo(node, "or") &&
          countSubqueryTerms(context, node.arguments) >= 2
        ) {
          context.report({ node, messageId: "noOrInArraySubqueries" });
        }
      },
    };
  },
});
