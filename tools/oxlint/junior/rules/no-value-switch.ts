import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

// Small switches read fine. A lookup table this large reads better as data.
const MIN_CASES = 8;

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

/**
 * Reject a large switch whose cases only return a value. It is a lookup
 * table: a map checked with `satisfies` reads as data and still fails to
 * compile when a key is missing. Switches whose cases run other statements,
 * or call a different function per case, stay.
 */
export const noValueSwitchRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow large switches whose cases only return a value for each key.",
    },
    messages: {
      valueSwitch:
        "This switch only returns a value for each case. Replace it with a map checked by `satisfies Record<Key, Value>`, or by a mapped type of per-type functions when a value needs the narrowed object, so a missing key still fails to compile. Check an untrusted key with `Object.hasOwn` before you index the map. Keep a switch only when its cases run different code.",
    },
  },
  create(context) {
    return {
      SwitchStatement(node) {
        // `default` often handles a key that the type does not know.
        const cases = node.cases.filter(
          (item) => item.test !== null && item.consequent.length > 0,
        );
        if (cases.length < MIN_CASES) return;
        const statements = cases.flatMap((item) => item.consequent);
        if (statements.every(returnsValue) && !statements.some(dispatches)) {
          context.report({ node, messageId: "valueSwitch" });
        }
      },
    };
  },
});
