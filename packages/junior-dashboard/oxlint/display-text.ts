import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

/**
 * API fields that hold display text. `title`, `description`, and `content`
 * are left out: most dashboard uses of those names are UI copy or React
 * nodes.
 */
const DISPLAY_TEXT_NAMES = new Set([
  "body",
  "instruction",
  "intent",
  "preview",
  "question",
  "summary",
  "text",
]);

type Node = ESTree.Expression | ESTree.JSXEmptyExpression;

function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | undefined {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) return variable;
    scope = scope.upper;
  }
  return undefined;
}

/** Return true when a parameter's own type literal declares `field`, as in `props: { text: string }`. */
function parameterDeclaresField(variable: Variable, field: string): boolean {
  const definition = variable.defs[0];
  if (definition?.type !== "Parameter") return false;
  const type = definition.name.typeAnnotation?.typeAnnotation;
  return (
    type?.type === "TSTypeLiteral" &&
    type.members.some(
      (member) =>
        member.type === "TSPropertySignature" &&
        member.key.type === "Identifier" &&
        member.key.name === field,
    )
  );
}

/**
 * Return the display-text field name that a local variable holds, as in
 * `const text = message.text ?? ""` or `const { text } = message`.
 * Parameters are inputs, so the caller decides how to render them.
 */
function variableDisplayTextName(
  sourceCode: SourceCode,
  variable: Variable,
  seen: Set<Variable>,
): string | undefined {
  if (seen.has(variable) || variable.defs.length !== 1) return undefined;
  seen.add(variable);
  const definition = variable.defs[0];
  if (definition?.type !== "Variable") return undefined;
  const declarator = definition.node;
  if (declarator.type !== "VariableDeclarator") return undefined;
  if (declarator.id.type === "Identifier") {
    return declarator.init
      ? displayTextName(sourceCode, declarator.init, seen)
      : undefined;
  }
  if (
    declarator.id.type !== "ObjectPattern" ||
    declarator.init?.type === "ObjectExpression"
  ) {
    return undefined;
  }
  const property = declarator.id.properties.find(
    (item) => item.type === "Property" && item.value === definition.name,
  );
  return property?.type === "Property" &&
    property.key.type === "Identifier" &&
    DISPLAY_TEXT_NAMES.has(property.key.name)
    ? property.key.name
    : undefined;
}

/** Return the display-text field name that this expression renders as a raw string. */
function displayTextName(
  sourceCode: SourceCode,
  node: Node,
  seen: Set<Variable>,
): string | undefined {
  switch (node.type) {
    case "Identifier": {
      const variable = resolveVariable(sourceCode, node);
      return variable
        ? variableDisplayTextName(sourceCode, variable, seen)
        : undefined;
    }
    case "MemberExpression": {
      if (
        node.computed ||
        node.property.type !== "Identifier" ||
        !DISPLAY_TEXT_NAMES.has(node.property.name)
      ) {
        return undefined;
      }
      const field = node.property.name;
      if (node.object.type === "Identifier") {
        const owner = resolveVariable(sourceCode, node.object);
        // `props.text` with `props: { text: string }` is a component input.
        if (owner && parameterDeclaresField(owner, field)) return undefined;
      }
      return field;
    }
    case "ChainExpression":
    case "TSNonNullExpression":
    case "TSAsExpression":
      return displayTextName(sourceCode, node.expression, seen);
    case "LogicalExpression":
      // `a && text` renders only `text`. `text ?? ""` and `text || ""` can render either side.
      return node.operator === "&&"
        ? displayTextName(sourceCode, node.right, seen)
        : (displayTextName(sourceCode, node.left, seen) ??
            displayTextName(sourceCode, node.right, seen));
    case "ConditionalExpression":
      return (
        displayTextName(sourceCode, node.consequent, seen) ??
        displayTextName(sourceCode, node.alternate, seen)
      );
    default:
      return undefined;
  }
}

/** Reject display text that JSX renders as a raw string instead of through `DisplayText`. */
export const noRawDisplayTextRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Render display text with DisplayText so Markdown, Slack mentions, links, and emoji codes render the same everywhere.",
    },
    messages: {
      rawDisplayText:
        "`{{name}}` is display text. Render it with `<DisplayText>` from `client/display-text/DisplayText`, or use `displayPlainText` where markup cannot go.",
    },
  },
  createOnce(context) {
    return {
      JSXExpressionContainer(node) {
        const parent = node.parent;
        if (parent.type !== "JSXElement" && parent.type !== "JSXFragment") {
          return;
        }
        const name = displayTextName(
          context.sourceCode,
          node.expression,
          new Set(),
        );
        if (name) {
          context.report({ node, messageId: "rawDisplayText", data: { name } });
        }
      },
    };
  },
});

/** Dashboard Oxlint rules that keep display text on the shared renderer. */
export default eslintCompatPlugin({
  meta: { name: "display-text" },
  rules: { "no-raw-display-text": noRawDisplayTextRule },
});
