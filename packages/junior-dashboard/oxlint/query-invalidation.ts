import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";

import type { Context, ESTree } from "@oxlint/plugins";

const REFRESH_METHODS = new Set([
  "invalidateQueries",
  "refetchQueries",
  "removeQueries",
  "resetQueries",
]);
// `["dashboard", "conversations"]` names a whole family of reads.
const MAX_PREFIX_LENGTH = 2;

function propertyValue(
  node: ESTree.ObjectExpression,
  key: string,
): ESTree.Node | undefined {
  for (const property of node.properties) {
    if (
      property.type === "Property" &&
      !property.computed &&
      property.key.type === "Identifier" &&
      property.key.name === key
    ) {
      return property.value;
    }
  }
  return undefined;
}

function unwrap(node: ESTree.Node): ESTree.Node {
  let current = node;
  while (
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression"
  ) {
    current = current.expression;
  }
  return current;
}

/** Return the initial value of a `const` in this file, if it has one. */
function constValue(
  context: Context,
  node: Extract<ESTree.Node, { type: "Identifier" }>,
): ESTree.Node | undefined {
  let scope: ReturnType<Context["sourceCode"]["getScope"]> | null =
    context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    if (variable) {
      const definition = variable.defs[0];
      return definition?.node.type === "VariableDeclarator" &&
        definition.parent?.type === "VariableDeclaration" &&
        definition.parent.kind === "const" &&
        definition.node.init
        ? unwrap(definition.node.init)
        : undefined;
    }
    scope = scope.upper;
  }
  return undefined;
}

function resolve(context: Context, node: ESTree.Node): ESTree.Node {
  const value = unwrap(node);
  return value.type === "Identifier"
    ? (constValue(context, value) ?? value)
    : value;
}

/**
 * Count the parts of a literal key. A spread of a key from another module
 * counts as a prefix, so `[...prefix, "count"]` names one family.
 */
function keyLength(context: Context, key: ESTree.ArrayExpression): number {
  let length = 0;
  for (const element of key.elements) {
    if (element?.type !== "SpreadElement") {
      length += 1;
      continue;
    }
    const spread = resolve(context, element.argument);
    if (spread.type === "CallExpression") return Number.POSITIVE_INFINITY;
    length +=
      spread.type === "ArrayExpression"
        ? keyLength(context, spread)
        : MAX_PREFIX_LENGTH;
  }
  return length;
}

/** Say whether a query key selects a whole family of reads. */
function isBroadKey(context: Context, node: ESTree.Node): boolean {
  const key = resolve(context, node);
  if (key.type === "CallExpression") return false;
  if (key.type === "ArrayExpression") {
    return keyLength(context, key) <= MAX_PREFIX_LENGTH;
  }
  // A key constant from another module is a bare prefix: it cannot carry the
  // parameters of one read.
  return true;
}

/**
 * Keep cache refreshes on the reads that a change affects. A short literal
 * prefix such as `["dashboard", "conversations"]` refetches every mounted
 * read under it, so one change can start a request for each open list.
 */
export const noBroadQueryInvalidationRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Refresh dashboard queries with a key factory or an exact key, not a broad prefix.",
    },
    messages: {
      broadKey:
        "`{{method}}` with this key refreshes every read under a broad prefix. Write the mutation response into the cache with `setQueryData`, or pass a key factory call (such as `inboxItemListQueryKey(filters)`) or `exact: true`. See policies/performance.md.",
      noKey:
        "`{{method}}` without a `queryKey` refreshes every query in the cache. Pass a key factory call or `exact: true`. See policies/performance.md.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          !REFRESH_METHODS.has(callee.property.name)
        ) {
          return;
        }
        const method = callee.property.name;
        const [argument] = node.arguments;
        if (!argument) {
          context.report({ node, messageId: "noKey", data: { method } });
          return;
        }
        const filters = resolve(context, argument);
        // Filters built elsewhere, such as a parameter, are not checked here.
        if (filters.type !== "ObjectExpression") return;
        const exact = propertyValue(filters, "exact");
        if (exact?.type === "Literal" && exact.value === true) return;
        const queryKey = propertyValue(filters, "queryKey");
        if (!queryKey) {
          // A predicate picks its reads by itself.
          if (propertyValue(filters, "predicate")) return;
          context.report({ node, messageId: "noKey", data: { method } });
          return;
        }
        if (isBroadKey(context, queryKey)) {
          context.report({ node, messageId: "broadKey", data: { method } });
        }
      },
    };
  },
});

/**
 * Keep queries off timers. A poll refetches whether its data changed or not,
 * and `/api/versions` already tells the client which reads changed. A read
 * that must poll disables this rule on its line with the reason.
 */
export const noRefetchIntervalRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Refresh dashboard queries from versions, not a poll.",
    },
    messages: {
      poll: "Do not poll with `refetchInterval`. Refresh the query from `/api/versions` or a mutation. If this read must poll, disable this rule on this line with the reason. See policies/performance.md.",
    },
  },
  create(context) {
    return {
      Property(node) {
        const key = node.key;
        if (
          !node.computed &&
          ((key.type === "Identifier" && key.name === "refetchInterval") ||
            (key.type === "Literal" && key.value === "refetchInterval"))
        ) {
          context.report({ node: key, messageId: "poll" });
        }
      },
    };
  },
});

/** Dashboard Oxlint rules that keep query refreshes narrow. */
export default eslintCompatPlugin({
  meta: { name: "query-invalidation" },
  rules: {
    "no-broad-query-invalidation": noBroadQueryInvalidationRule,
    "no-refetch-interval": noRefetchIntervalRule,
  },
});
