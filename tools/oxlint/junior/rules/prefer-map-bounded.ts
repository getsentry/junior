import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/** Return the call that an arrow callback only returns, if it has one. */
function returnedCall(
  callback: ESTree.ArrowFunctionExpression,
): ESTree.Node | null | undefined {
  if (callback.body.type !== "BlockStatement") return callback.body;
  const [only, ...rest] = callback.body.body;
  return rest.length === 0 && only?.type === "ReturnStatement"
    ? only.argument
    : undefined;
}

/**
 * Return the `Promise.all(list.map(callback))` call when the limiter call is
 * the whole callback, as in `list.map((item) => limit(() => work(item)))`.
 */
function wrappedMapAll(
  limiterCall: ESTree.CallExpression,
): ESTree.CallExpression | undefined {
  let callback: ESTree.Node | null = limiterCall.parent;
  if (callback?.type === "ReturnStatement")
    callback = callback.parent?.parent ?? null;
  if (
    callback?.type !== "ArrowFunctionExpression" ||
    returnedCall(callback) !== limiterCall
  ) {
    return undefined;
  }
  const map = callback.parent;
  if (
    map?.type !== "CallExpression" ||
    map.arguments[0] !== callback ||
    map.callee.type !== "MemberExpression" ||
    map.callee.computed ||
    map.callee.property.type !== "Identifier" ||
    map.callee.property.name !== "map"
  ) {
    return undefined;
  }
  const all = map.parent;
  if (
    all?.type !== "CallExpression" ||
    all.arguments[0] !== map ||
    all.callee.type !== "MemberExpression" ||
    all.callee.computed ||
    all.callee.object.type !== "Identifier" ||
    all.callee.object.name !== "Promise" ||
    all.callee.property.type !== "Identifier" ||
    all.callee.property.name !== "all"
  ) {
    return undefined;
  }
  return all;
}

/**
 * Flag a `p-limit` limiter that only wraps the callback of one
 * `Promise.all(list.map(...))`. `mapBounded` in core, or `pLimit(N).map` in a
 * plugin, says the same in one call. A limiter that several lists share, a
 * `Promise.allSettled`, and `limit.map` itself stay.
 */
export const preferMapBoundedRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require mapBounded or pLimit(N).map instead of a limiter that wraps one Promise.all(list.map(...)).",
    },
    messages: {
      preferMapBounded:
        "This limiter only bounds one `Promise.all(list.map(...))`. Use `mapBounded(list, work)` from `@/chat/fan-out` (in a plugin, `pLimit(N).map(list, work)`). See policies/performance.md.",
    },
  },
  create(context) {
    const pLimitNames = new Set<string>();

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "p-limit") return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportDefaultSpecifier") {
            pLimitNames.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        if (
          node.callee.type !== "Identifier" ||
          !pLimitNames.has(node.callee.name)
        ) {
          return;
        }
        const parent = node.parent;
        // `pLimit(N)(() => work(item))` inside the callback.
        if (parent?.type === "CallExpression" && parent.callee === node) {
          const all = wrappedMapAll(parent);
          if (all) context.report({ node: all, messageId: "preferMapBounded" });
          return;
        }
        // `const limit = pLimit(N)` with one use that wraps the callback.
        if (parent?.type !== "VariableDeclarator" || parent.init !== node) {
          return;
        }
        for (const variable of context.sourceCode.getDeclaredVariables(
          parent,
        )) {
          const reads = variable.references.filter((reference) =>
            reference.isRead(),
          );
          const use =
            reads.length === 1 ? reads[0]?.identifier.parent : undefined;
          if (
            use?.type !== "CallExpression" ||
            use.callee !== reads[0]?.identifier
          ) {
            continue;
          }
          const all = wrappedMapAll(use);
          if (all) context.report({ node: all, messageId: "preferMapBounded" });
        }
      },
    };
  },
});
