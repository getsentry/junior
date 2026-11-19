import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

// Small switches read fine. A lookup table this large reads better as data.
const MIN_CASES = 8;

// A key handler or a router with this many cases already reads as a table.
const MIN_ACTION_CASES = 3;

// More statements than this in a case are a procedure, not one action.
const MAX_CASE_ACTIONS = 3;

function returnsValue(statement: ESTree.Node): boolean {
  if (statement.type === "ReturnStatement") return true;
  return (
    statement.type === "BlockStatement" &&
    statement.body.every(
      (inner) =>
        inner.type === "ReturnStatement" ||
        (inner.type === "VariableDeclaration" && inner.kind !== "var"),
    )
  );
}

// A case that returns a call to a plain function chooses which code runs.
function dispatches(statement: ESTree.Node): boolean {
  return (
    statement.type === "ReturnStatement" &&
    statement.argument?.type === "CallExpression" &&
    statement.argument.callee.type === "Identifier"
  );
}

function caseStatements(item: ESTree.SwitchCase): ESTree.Node[] {
  const [only, ...rest] = item.consequent;
  return only?.type === "BlockStatement" && rest.length === 0
    ? only.body
    : item.consequent;
}

// One expression, such as a call or an assignment. A guard without `else`
// around one expression is still one action.
function isAction(statement: ESTree.Node): boolean {
  if (statement.type === "ExpressionStatement") return true;
  if (statement.type !== "IfStatement" || statement.alternate) return false;
  const body =
    statement.consequent.type === "BlockStatement"
      ? statement.consequent.body
      : [statement.consequent];
  return body.length === 1 && body[0]?.type === "ExpressionStatement";
}

function isExit(statement: ESTree.Node): boolean {
  return (
    (statement.type === "BreakStatement" && !statement.label) ||
    statement.type === "ReturnStatement"
  );
}

/** Count the actions of a case, or return undefined when it does more. */
function caseActions(
  item: ESTree.SwitchCase,
  isLastCase: boolean,
): number | undefined {
  const statements = caseStatements(item);
  const last = statements.at(-1);
  const exits = last !== undefined && isExit(last);
  // A case that falls through into the next one shares that case's work.
  if (!exits && !isLastCase) return undefined;
  const actions = exits ? statements.slice(0, -1) : statements;
  if (actions.length > MAX_CASE_ACTIONS || !actions.every(isAction)) {
    return undefined;
  }
  return actions.length;
}

function rootObject(node: ESTree.Node): ESTree.Node {
  if (node.type === "MemberExpression") return rootObject(node.object);
  if (node.type === "ChainExpression") return rootObject(node.expression);
  return node;
}

function resolveVariable(
  sourceCode: SourceCode,
  node: ESTree.Node,
  name: string,
): Variable | undefined {
  let scope: Scope | null = sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return undefined;
}

// A case that reads the switched value, or the object that holds it, can
// rely on narrowing: a discriminated union field, or a `never` check.
function casesReadSwitchedValue(
  sourceCode: SourceCode,
  node: ESTree.SwitchStatement,
): boolean {
  const root = rootObject(node.discriminant);
  if (root.type !== "Identifier") return false;
  const variable = resolveVariable(sourceCode, root, root.name);
  if (!variable) return false;
  const [start, end] = [node.discriminant.range[1], node.range[1]];
  return variable.references.some(
    ({ identifier }) =>
      identifier.range[0] >= start && identifier.range[1] <= end,
  );
}

/**
 * Reject a switch that is a lookup table in disguise:
 *
 * - `valueSwitch`: `MIN_CASES` or more cases that only return a value.
 * - `actionSwitch`: `MIN_ACTION_CASES` or more cases that each run at most
 *   `MAX_CASE_ACTIONS` expressions (a call or an assignment, optionally
 *   behind an `if` with no `else`) and then `break` or `return`, or end the
 *   switch, when at least one case runs an expression and no case reads
 *   the switched value or its object. A case that falls through into the
 *   next one does not count as an action.
 *
 * A map checked with `satisfies` reads as data and still fails to compile
 * when a key is missing. Switches stay when a case calls a different function
 * per key, declares a variable, throws, loops, or branches, or reads the
 * switched value or its object, because that case can rely on narrowing.
 */
export const noValueSwitchRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow switches whose cases only return a value or run a short action for each key.",
    },
    messages: {
      valueSwitch:
        "This switch only returns a value for each case. Replace it with a map checked by `satisfies Record<Key, Value>`, or by a mapped type of per-type functions when a value needs the narrowed object, so a missing key still fails to compile. Check an untrusted key with `Object.hasOwn` before you index the map. Keep a switch only when its cases run different code.",
      actionSwitch:
        "Each case of this switch only runs a short action. Replace it with a map from key to action, or to the data that the actions differ by, checked by `satisfies Record<Key, …>`. Use `Partial<Record<Key, …>>` and a check when some keys have no entry. Check an untrusted key with `Object.hasOwn` before you index the map.",
    },
  },
  create(context) {
    return {
      SwitchStatement(node) {
        // `default` often handles a key that the type does not know.
        const cases = node.cases.filter(
          (item) => item.test !== null && item.consequent.length > 0,
        );
        const statements = cases.flatMap((item) => item.consequent);
        if (
          cases.length >= MIN_CASES &&
          statements.every(returnsValue) &&
          !statements.some(dispatches)
        ) {
          context.report({ node, messageId: "valueSwitch" });
          return;
        }
        if (cases.length < MIN_ACTION_CASES) return;
        const actions = node.cases
          .filter((item) => item.consequent.length > 0)
          .map((item) => caseActions(item, item === node.cases.at(-1)));
        if (
          actions.every((count) => count !== undefined) &&
          actions.some((count) => count > 0) &&
          !casesReadSwitchedValue(context.sourceCode, node)
        ) {
          context.report({ node, messageId: "actionSwitch" });
        }
      },
    };
  },
});
