import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

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

/** Return the display-text field name that this JSX child renders as a raw string. */
function renderedDisplayTextName(
  node: ESTree.Expression | ESTree.JSXEmptyExpression,
): string | undefined {
  switch (node.type) {
    case "Identifier":
      return DISPLAY_TEXT_NAMES.has(node.name) ? node.name : undefined;
    case "MemberExpression":
      return !node.computed &&
        node.property.type === "Identifier" &&
        DISPLAY_TEXT_NAMES.has(node.property.name)
        ? node.property.name
        : undefined;
    case "ChainExpression":
    case "TSNonNullExpression":
    case "TSAsExpression":
      return renderedDisplayTextName(node.expression);
    case "LogicalExpression":
      // `a && text` renders only `text`. `text ?? ""` and `text || ""` can render either side.
      return node.operator === "&&"
        ? renderedDisplayTextName(node.right)
        : (renderedDisplayTextName(node.left) ??
            renderedDisplayTextName(node.right));
    case "ConditionalExpression":
      return (
        renderedDisplayTextName(node.consequent) ??
        renderedDisplayTextName(node.alternate)
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
        "`{{name}}` looks like display text. Render it with `<DisplayText>` from `client/display-text/DisplayText`, or use `displayPlainText` where markup cannot go. If it is not display text, disable this line with a reason.",
    },
  },
  createOnce(context) {
    return {
      JSXExpressionContainer(node) {
        const parent = node.parent;
        if (parent.type !== "JSXElement" && parent.type !== "JSXFragment") {
          return;
        }
        const name = renderedDisplayTextName(node.expression);
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
