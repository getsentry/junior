import { defineRule } from "@oxlint/plugins";

import type { Context, ESTree, Scope, Variable } from "@oxlint/plugins";

const combinators = new Set(["all", "allSettled"]);
const mappers = new Set(["map", "flatMap"]);

/** Find the variable that an identifier names, from its own scope out. */
function resolve(context: Context, node: ESTree.Node, name: string) {
  for (
    let scope: Scope | null = context.sourceCode.getScope(node);
    scope;
    scope = scope.upper
  ) {
    const variable = scope.set.get(name);
    if (variable) return variable;
  }
  return undefined;
}

/** Return the only definition of a `const` binding or a parameter. */
function definition(variable: Variable | undefined) {
  const [only, ...rest] = variable?.defs ?? [];
  if (!only || rest.length > 0) return undefined;
  if (only.type === "Parameter") return only;
  if (
    only.type === "Variable" &&
    only.parent?.type === "VariableDeclaration" &&
    only.parent.kind === "const"
  ) {
    return only;
  }
  return undefined;
}

/** Say whether a node is an array literal with no spread. */
function isArrayLiteral(node: ESTree.Node | null | undefined): boolean {
  return (
    node?.type === "ArrayExpression" &&
    node.elements.every((element) => element?.type !== "SpreadElement")
  );
}

/** Say whether a written type has a fixed length: a tuple, or a readonly one. */
function isTupleType(type: ESTree.Node | null | undefined): boolean {
  if (type?.type === "TSTupleType") {
    return type.elementTypes.every((element) => element.type !== "TSRestType");
  }
  return (
    type?.type === "TSTypeOperator" &&
    type.operator === "readonly" &&
    isTupleType(type.typeAnnotation)
  );
}

/** Say whether an expression fixes its length in the code, like `[a, b] as const`. */
function isFixedExpression(node: ESTree.Node | null | undefined): boolean {
  if (isArrayLiteral(node)) return true;
  if (node?.type !== "TSAsExpression" && node?.type !== "TSSatisfiesExpression")
    return false;
  const constAssertion =
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const";
  return (
    isArrayLiteral(node.expression) &&
    (constAssertion || isTupleType(node.typeAnnotation))
  );
}

/** Say whether a node is a number literal or a module-level `const` of one. */
function isConstantNumber(context: Context, node: ESTree.Node | undefined) {
  if (node?.type === "Literal") return typeof node.value === "number";
  if (node?.type !== "Identifier") return false;
  const variable = resolve(context, node, node.name);
  const def = definition(variable);
  return (
    variable?.scope.type === "module" &&
    def?.node.type === "VariableDeclarator" &&
    def.node.init?.type === "Literal" &&
    typeof def.node.init.value === "number"
  );
}

/** Say whether a node is `list.slice(0, MAX)` with a constant `MAX`. */
function isCappedSlice(context: Context, node: ESTree.Node | null | undefined) {
  if (
    node?.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression" ||
    node.callee.computed ||
    node.callee.property.type !== "Identifier" ||
    node.callee.property.name !== "slice"
  ) {
    return false;
  }
  const [start, end] = node.arguments;
  return (
    start?.type === "Literal" &&
    start.value === 0 &&
    isConstantNumber(context, end)
  );
}

/**
 * Say whether a mapped list has a length that the code fixes: an array
 * literal, an `as const` or tuple-typed array, a binding whose written type is
 * a tuple, `list.slice(0, MAX)` with a constant `MAX`, or `{ length: 3 }`.
 * Oxlint JS plugins see no inferred types, so a tuple type counts only where
 * the code writes it.
 */
function isFixedList(context: Context, node: ESTree.Node): boolean {
  if (isFixedExpression(node) || isCappedSlice(context, node)) return true;
  if (
    node.type === "ObjectExpression" &&
    node.properties.some(
      (property) =>
        property.type === "Property" &&
        !property.computed &&
        property.key.type === "Identifier" &&
        property.key.name === "length" &&
        property.value.type === "Literal" &&
        typeof property.value.value === "number",
    )
  ) {
    return true;
  }
  if (node.type !== "Identifier") return false;
  const variable = resolve(context, node, node.name);
  const def = definition(variable);
  if (!def) return false;
  if (isTupleType(typeAnnotationOf(def.name))) return true;
  if (def.node.type !== "VariableDeclarator") return false;
  const init = def.node.init;
  // A plain array literal in a binding can grow with `push`, so only
  // `as const` or a tuple type fixes its length.
  return (
    isCappedSlice(context, init) ||
    (init?.type !== "ArrayExpression" && isFixedExpression(init))
  );
}

/** Return the type written on a binding identifier, if any. */
function typeAnnotationOf(identifier: ESTree.Node) {
  return "typeAnnotation" in identifier && identifier.typeAnnotation
    ? (identifier.typeAnnotation as ESTree.TSTypeAnnotation).typeAnnotation
    : undefined;
}

/** Return what an arrow callback returns, when its body is one expression. */
function returned(callback: ESTree.ArrowFunctionExpression) {
  if (callback.body.type !== "BlockStatement") return callback.body;
  const [only, ...rest] = callback.body.body;
  return rest.length === 0 && only?.type === "ReturnStatement"
    ? only.argument
    : undefined;
}

/**
 * Say whether a callback can start async work per item: an async function,
 * an arrow that returns a call or an array of calls, or a function reference.
 */
function startsWork(callback: ESTree.Node | undefined): boolean {
  if (!callback) return false;
  if (callback.type === "Identifier" || callback.type === "MemberExpression")
    return true;
  if (callback.type === "FunctionExpression") return callback.async;
  if (callback.type !== "ArrowFunctionExpression") return false;
  if (callback.async) return true;
  const body = returned(callback);
  // A `flatMap` callback can return several calls in an array.
  return (
    body?.type === "CallExpression" ||
    (body?.type === "ArrayExpression" &&
      body.elements.some((element) => element?.type === "CallExpression"))
  );
}

/**
 * Return the list and the callback of `list.map(fn)`, `list.flatMap(fn)`, or
 * `Array.from(list, fn)`.
 */
function mappedCall(node: ESTree.Node | null | undefined) {
  if (
    node?.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression"
  )
    return undefined;
  const { callee } = node;
  if (callee.computed || callee.property.type !== "Identifier")
    return undefined;
  if (mappers.has(callee.property.name)) {
    return { list: callee.object, callback: node.arguments[0] };
  }
  if (
    callee.object.type === "Identifier" &&
    callee.object.name === "Array" &&
    callee.property.name === "from" &&
    node.arguments.length >= 2
  ) {
    return { list: node.arguments[0], callback: node.arguments[1] };
  }
  return undefined;
}

/**
 * Flag `Promise.all(list.map(work))` over a list whose length is not fixed in
 * the code. It covers `map`, `flatMap`, and `Array.from(list, work)`, a work
 * callback that is async, returns a call, or is a function reference, and a
 * `const` that holds the mapped promises. Each item starts its work at once,
 * so a long list opens as many database connections or provider requests as
 * it has items. A callback that runs its work through a `p-limit` limiter is
 * bounded.
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
        "This starts one async call per list item at once. Read the items in one batched call, or bound the calls with `mapBounded(list, work)` from `@/chat/fan-out` (in a plugin, `pLimit(N).map(list, work)`). See policies/performance.md.",
    },
  },
  create(context) {
    const limiters = new Set<string>();
    const limiterCalls: ESTree.Node[] = [];
    const pLimitNames = new Set<string>();
    // Each mapped call, with the function whose body may call a limiter.
    const candidates: Array<{ node: ESTree.Node; work: ESTree.Node }> = [];

    /** Return the function that a callback is or names, if it is local. */
    function workOf(callback: ESTree.Node): ESTree.Node {
      if (callback.type !== "Identifier") return callback;
      const def = definition(resolve(context, callback, callback.name));
      const init =
        def?.node.type === "VariableDeclarator" ? def.node.init : def?.node;
      return init?.type === "ArrowFunctionExpression" ||
        init?.type === "FunctionExpression" ||
        init?.type === "FunctionDeclaration"
        ? init
        : callback;
    }

    /** Add the mapped call that a `Promise.all` argument is or names. */
    function addCandidate(argument: ESTree.Node | undefined) {
      let mapped: ESTree.Node | null | undefined = argument;
      if (argument?.type === "Identifier") {
        const def = definition(resolve(context, argument, argument.name));
        mapped =
          def?.node.type === "VariableDeclarator" ? def.node.init : undefined;
      }
      const call = mappedCall(mapped);
      if (
        !mapped ||
        !call?.list ||
        !call.callback ||
        !startsWork(call.callback) ||
        isFixedList(context, call.list)
      ) {
        return;
      }
      candidates.push({ node: mapped, work: workOf(call.callback) });
    }

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
          limiterCalls.push(node);
          return;
        }
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.object.type === "Identifier" &&
          callee.object.name === "Promise" &&
          callee.property.type === "Identifier" &&
          combinators.has(callee.property.name)
        ) {
          addCandidate(node.arguments[0]);
        }
      },
      "Program:exit"() {
        // A work function is bounded when a limiter call is inside it.
        const limited = new Set<ESTree.Node>();
        for (const call of limiterCalls) {
          for (
            let current: ESTree.Node | null = call.parent;
            current;
            current = current.parent
          ) {
            limited.add(current);
          }
        }
        for (const { node, work } of candidates) {
          if (!limited.has(work)) {
            context.report({ node, messageId: "unbounded" });
          }
        }
      },
    };
  },
});
