import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference | ESTree.BindingIdentifier,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

function isAsyncFunction(node: ESTree.Node | null | undefined): boolean {
  return (
    (node?.type === "FunctionDeclaration" ||
      node?.type === "ArrowFunctionExpression" ||
      node?.type === "FunctionExpression") &&
    node.async
  );
}

/**
 * Say whether an identifier names the production implementation of a
 * service: a camelCase import, or an async function that the module declares
 * at its top level. Without types, the camelCase name tells an imported
 * function or service from an imported constant (`UPPER_CASE`) or component
 * (`PascalCase`), and `async` tells a function that does I/O from a pure
 * helper of the module, such as a formatter or a replacer.
 */
function isServiceImplementation(
  sourceCode: SourceCode,
  node: ESTree.Expression,
): node is ESTree.IdentifierReference {
  if (node.type !== "Identifier" || !/^[a-z]/.test(node.name)) return false;
  const variable = resolveVariable(sourceCode, node);
  if (variable?.scope.type !== "module") return false;
  return variable.defs.some(
    (definition) =>
      definition.type === "ImportBinding" ||
      (definition.type === "FunctionName" &&
        isAsyncFunction(definition.node)) ||
      (definition.type === "Variable" &&
        definition.node.type === "VariableDeclarator" &&
        isAsyncFunction(definition.node.init)),
  );
}

/**
 * Say whether code only reads fields from a value, such as `columns.model`.
 * A value that is never called, never has a method called, and never passes
 * to other code is data, such as a table, and not a service.
 */
function isFieldRead(node: ESTree.Node): boolean {
  const parent = node.parent;
  return (
    parent?.type === "MemberExpression" &&
    parent.object === node &&
    !(
      parent.parent?.type === "CallExpression" &&
      parent.parent.callee === parent
    )
  );
}

function isReadAsData(variable: Variable | null): boolean {
  if (variable === null) return false;
  const reads = variable.references.filter((reference) => reference.isRead());
  return (
    reads.length > 0 && reads.every((read) => isFieldRead(read.identifier))
  );
}

/** Say whether the result of `deps.x ?? fn` is only read as data. */
function isFallbackReadAsData(
  sourceCode: SourceCode,
  node: ESTree.LogicalExpression,
): boolean {
  const parent = node.parent;
  if (
    parent?.type === "VariableDeclarator" &&
    parent.init === node &&
    parent.id.type === "Identifier"
  ) {
    return isReadAsData(resolveVariable(sourceCode, parent.id));
  }
  return isFieldRead(node);
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
 * such as `deps.record ?? recordDenied` or `{ record = recordDenied }`. The option exists only so a test can swap the
 * function, and every caller pays for it. See policies/interface-design.md,
 * "Services".
 */
export const noServiceFallbackRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow optional services that fall back to the production function or service.",
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
        if (!isServiceImplementation(sourceCode, node.right)) return;
        if (isFallbackReadAsData(sourceCode, node)) return;
        context.report({
          node,
          messageId: "fallback",
          data: { name: node.right.name },
        });
      },
      AssignmentPattern(node) {
        if (!isServiceImplementation(sourceCode, node.right)) return;
        if (!isParameterDefault(node)) return;
        if (
          node.left.type === "Identifier" &&
          isReadAsData(resolveVariable(sourceCode, node.left))
        ) {
          return;
        }
        context.report({
          node,
          messageId: "fallback",
          data: { name: node.right.name },
        });
      },
    };
  },
});
