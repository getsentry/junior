import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/** Px values of module `const NAME_PX = 8` and `const NAME_PX = { a: 6 }` declarations, by `NAME` or `NAME.a`. */
type PxConstants = Map<string, number>;

type Use = { name: string; node: ESTree.Node; value: number };

function numberValue(node: ESTree.Node | null | undefined): number | undefined {
  return node?.type === "Literal" && typeof node.value === "number"
    ? node.value
    : undefined;
}

function collectPxConstants(program: ESTree.Program): PxConstants {
  const constants: PxConstants = new Map();
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    if (declaration.kind !== "const") continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== "Identifier") continue;
      const name = declarator.id.name;
      if (!name.endsWith("_PX")) continue;
      const init =
        declarator.init?.type === "TSAsExpression"
          ? declarator.init.expression
          : declarator.init;
      const value = numberValue(init);
      if (value !== undefined) constants.set(name, value);
      if (init?.type !== "ObjectExpression") continue;
      for (const property of init.properties) {
        if (
          property.type !== "Property" ||
          property.key.type !== "Identifier"
        ) {
          continue;
        }
        const member = numberValue(property.value);
        if (member !== undefined) {
          constants.set(`${name}.${property.key.name}`, member);
        }
      }
    }
  }
  return constants;
}

/** Return `NAME` or `NAME.key` for a px constant reference. */
function constantName(node: ESTree.Node): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.property.type === "Identifier"
  ) {
    return `${node.object.name}.${node.property.name}`;
  }
  return undefined;
}

function insideStyleAttribute(node: ESTree.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      parent.type === "JSXAttribute" &&
      parent.name.type === "JSXIdentifier" &&
      parent.name.name === "style"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Keep a px constant that maps positions to elements (`y / ITEM_PX`,
 * `index * ITEM_PX`) equal to the size those elements render at. Rem
 * utilities such as `h-2` grow with the browser font size, so a px constant
 * matches them only at the default size. The file must size the elements
 * with the constant: an inline `style` that uses it, or a `[Npx]` class with
 * its value.
 */
export const pxConstantSizesElementRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Size the elements that a px geometry constant maps to with that constant, so the math matches at any browser font size.",
    },
    messages: {
      unbacked:
        "`{{name}}` maps positions with a fixed {{value}}px, but no element in this file uses that size. A rem class such as `h-2` matches it only at the default font size. Size the element with `{{name}}` in `style` or with a `[{{value}}px]` class, or measure the element instead.",
    },
  },
  createOnce(context) {
    let constants: PxConstants = new Map();
    let uses: Use[] = [];
    let styled = new Set<string>();
    return {
      Program(node) {
        constants = collectPxConstants(node);
        uses = [];
        styled = new Set();
      },
      BinaryExpression(node) {
        if (node.operator !== "*" && node.operator !== "/") return;
        for (const operand of [node.left, node.right]) {
          const name = constantName(operand);
          const value = name === undefined ? undefined : constants.get(name);
          if (name !== undefined && value !== undefined) {
            uses.push({ name, node, value });
          }
        }
      },
      "Identifier, MemberExpression"(node: ESTree.Node) {
        const name = constantName(node);
        if (name && constants.has(name) && insideStyleAttribute(node)) {
          styled.add(name);
        }
      },
      "Program:exit"() {
        if (uses.length === 0) return;
        const text = context.sourceCode.getText();
        for (const use of uses) {
          if (styled.has(use.name) || text.includes(`[${use.value}px]`)) {
            continue;
          }
          context.report({
            node: use.node,
            messageId: "unbacked",
            data: { name: use.name, value: String(use.value) },
          });
        }
      },
    };
  },
});

/** Dashboard Oxlint rules that keep JS px geometry equal to the rendered CSS. */
export default eslintCompatPlugin({
  meta: { name: "px-geometry" },
  rules: { "px-constant-sizes-element": pxConstantSizesElementRule },
});
