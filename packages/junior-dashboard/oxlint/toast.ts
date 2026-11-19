import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

// Toast manager calls that show a toast. `update` takes the toast id first.
const TOAST_METHODS = new Set(["add", "update"]);

function propertyValue(
  node: ESTree.ObjectExpression,
  key: string,
): ESTree.Node | undefined {
  for (const item of node.properties) {
    if (
      item.type === "Property" &&
      !item.computed &&
      item.key.type === "Identifier" &&
      item.key.name === key
    ) {
      return item.value;
    }
  }
  return undefined;
}

function isUndefined(node: ESTree.Node): boolean {
  return node.type === "Identifier" && node.name === "undefined";
}

function calledMethod(node: ESTree.CallExpression): string | undefined {
  const callee = node.callee;
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return undefined;
}

/**
 * Keep toasts for actions, errors, and results that the screen does not
 * show. A success toast with no action only confirms a change, and the
 * screen already shows that change.
 */
export const actionlessSuccessToastRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Show a success toast only with an action, such as Undo or Retry.",
    },
    messages: {
      actionless:
        "A success toast with no action only repeats what the screen shows. Drop it, or give it an action such as Undo. When the screen does not show the result, add an `oxlint-disable-next-line` comment that says so.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const method = calledMethod(node);
        if (!method || !TOAST_METHODS.has(method)) return;
        for (const argument of node.arguments) {
          if (argument.type !== "ObjectExpression") continue;
          // A spread can carry the action or the type, so it is not known.
          if (argument.properties.some((item) => item.type !== "Property"))
            continue;
          const type = propertyValue(argument, "type");
          if (type?.type !== "Literal" || type.value !== "success") continue;
          const action = propertyValue(argument, "actionProps");
          if (action && !isUndefined(action)) continue;
          context.report({ node: argument, messageId: "actionless" });
        }
      },
    };
  },
});

/** Dashboard Oxlint rules for toasts. */
export default eslintCompatPlugin({
  meta: { name: "toast" },
  rules: { "no-actionless-success": actionlessSuccessToastRule },
});
