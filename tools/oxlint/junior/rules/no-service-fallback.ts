import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

function isFunctionExpression(node: ESTree.Node | null | undefined): boolean {
  return (
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionExpression"
  );
}

/**
 * Say whether an identifier names a camelCase import or a function that the
 * module declares at its top level: the production implementation of a
 * service. Without types, the camelCase name tells an imported function from
 * an imported constant (`UPPER_CASE`) or component (`PascalCase`).
 */
function isModuleFunction(
  sourceCode: SourceCode,
  node: ESTree.Expression,
): node is ESTree.IdentifierReference {
  if (node.type !== "Identifier") return false;
  const variable = resolveVariable(sourceCode, node);
  if (variable?.scope.type !== "module") return false;
  return variable.defs.some(
    (definition) =>
      (definition.type === "ImportBinding" && /^[a-z]/.test(node.name)) ||
      definition.type === "FunctionName" ||
      (definition.type === "Variable" &&
        definition.node.type === "VariableDeclarator" &&
        isFunctionExpression(definition.node.init)),
  );
}

/** Say whether a default value belongs to a destructured function parameter. */
function isParameterDefault(node: ESTree.AssignmentPattern): boolean {
  let current: ESTree.Node | null = node.parent;
  while (current?.type === "Property" || current?.type === "ObjectPattern") {
    current = current.parent;
  }
  return (
    current?.type === "FunctionDeclaration" ||
    current?.type === "FunctionExpression" ||
    current?.type === "ArrowFunctionExpression" ||
    (current?.type === "AssignmentPattern" &&
      current.left.type === "ObjectPattern")
  );
}

/**
 * Reject an optional service that falls back to the production function,
 * such as `deps.record ?? recordDenied` or `{ record = recordDenied }`. The
 * option exists only so a test can swap the function, and every caller pays
 * for it. See policies/interface-design.md, "Services".
 */
export const noServiceFallbackRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow optional services that fall back to an imported or module function.",
    },
    messages: {
      fallback:
        "Call `{{name}}` directly. An optional service that falls back to the production function is test-only dependency injection: test the real path, or fake the edge with a test adapter (policies/test-adapters.md). If production callers choose the service, make it required (policies/interface-design.md, Services).",
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      LogicalExpression(node) {
        if (node.operator !== "??" && node.operator !== "||") return;
        if (node.left.type !== "MemberExpression") return;
        if (!isModuleFunction(sourceCode, node.right)) return;
        context.report({
          node,
          messageId: "fallback",
          data: { name: node.right.name },
        });
      },
      AssignmentPattern(node) {
        if (!isModuleFunction(sourceCode, node.right)) return;
        if (!isParameterDefault(node)) return;
        context.report({
          node,
          messageId: "fallback",
          data: { name: node.right.name },
        });
      },
    };
  },
});
