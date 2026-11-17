import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const combinators = new Set(["all", "allSettled"]);

/** Say whether a mapped list is an array literal with no spread. */
function isFixedList(node: ESTree.Node): boolean {
  return (
    node.type === "ArrayExpression" &&
    node.elements.every((element) => element?.type !== "SpreadElement")
  );
}

/**
 * Flag `Promise.all(list.map(async (item) => ...))` over a list whose length
 * is not fixed in the code. Each item starts its work at once, so a long list
 * opens as many database connections or provider requests as it has items.
 * A callback that runs its work through a `p-limit` limiter is bounded.
 */
export const boundedFanOutRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a p-limit limiter when Promise.all maps async work over a list.",
    },
    messages: {
      unbounded:
        "This starts one async call per list item at once. Read the items in one batched call, or run each call through a p-limit limiter: `const limit = pLimit(N)` and `list.map((item) => limit(() => work(item)))`. See policies/performance.md.",
    },
  },
  create(context) {
    const limiters = new Set<string>();
    const pLimitNames = new Set<string>();
    // Each mapped callback, and whether it calls a limiter.
    const candidates = new Map<
      ESTree.Node,
      { node: ESTree.Node; limited: boolean }
    >();

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "p-limit") return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportDefaultSpecifier") {
            pLimitNames.add(specifier.local.name);
          }
        }
      },
      VariableDeclarator(node) {
        if (
          node.id.type === "Identifier" &&
          node.init?.type === "CallExpression" &&
          node.init.callee.type === "Identifier" &&
          pLimitNames.has(node.init.callee.name)
        ) {
          limiters.add(node.id.name);
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === "Identifier" && limiters.has(callee.name)) {
          for (
            let current: ESTree.Node | null = node.parent;
            current;
            current = current.parent
          ) {
            const candidate = candidates.get(current);
            if (candidate) candidate.limited = true;
          }
          return;
        }
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.object.type !== "Identifier" ||
          callee.object.name !== "Promise" ||
          callee.property.type !== "Identifier" ||
          !combinators.has(callee.property.name)
        ) {
          return;
        }
        const mapped = node.arguments[0];
        if (
          mapped?.type !== "CallExpression" ||
          mapped.callee.type !== "MemberExpression" ||
          mapped.callee.computed ||
          mapped.callee.property.type !== "Identifier" ||
          mapped.callee.property.name !== "map" ||
          isFixedList(mapped.callee.object)
        ) {
          return;
        }
        const callback = mapped.arguments[0];
        if (
          (callback?.type !== "ArrowFunctionExpression" &&
            callback?.type !== "FunctionExpression") ||
          !callback.async
        ) {
          return;
        }
        candidates.set(callback, { node: mapped, limited: false });
      },
      "Program:exit"() {
        for (const { node, limited } of candidates.values()) {
          if (!limited) context.report({ node, messageId: "unbounded" });
        }
      },
    };
  },
});
