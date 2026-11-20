import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/** Input types that are not text boxes, so Ctrl+Enter has nothing to send. */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Return the literal `type` of an `<input>`, `""` when it has none, or undefined when it is dynamic. */
function inputType(node: ESTree.JSXOpeningElement): string | undefined {
  const attribute = node.attributes.find(
    (item) =>
      item.type === "JSXAttribute" &&
      item.name.type === "JSXIdentifier" &&
      item.name.name === "type",
  );
  if (!attribute || attribute.type !== "JSXAttribute") return "";
  const value = attribute.value;
  if (value?.type === "Literal" && typeof value.value === "string") {
    return value.value;
  }
  if (
    value?.type === "JSXExpressionContainer" &&
    value.expression.type === "Literal" &&
    typeof value.expression.value === "string"
  ) {
    return value.expression.value;
  }
  return undefined;
}

/**
 * Keep dashboard text boxes on `Input`, `Textarea`, or `BareTextarea` from
 * `components/ui`, which send their form on Ctrl+Enter or Cmd+Enter.
 */
export const noRawTextControlRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Render text boxes with the components/ui text controls so Ctrl+Enter and Cmd+Enter send the form everywhere.",
    },
    messages: {
      rawTextControl:
        "Use `Input`, `Textarea`, or `BareTextarea` from `components/ui` instead of `<{{name}}>`, so Ctrl+Enter and Cmd+Enter send the form.",
      primitiveImport:
        "Use `Input` from `components/ui/input` instead of the Base UI input, so Ctrl+Enter and Cmd+Enter send the form.",
    },
  },
  createOnce(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value === "@base-ui/react/input") {
          context.report({ node, messageId: "primitiveImport" });
        }
      },
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const name = node.name.name;
        if (name === "input") {
          const type = inputType(node);
          if (type !== undefined && NON_TEXT_INPUT_TYPES.has(type)) return;
        } else if (name !== "textarea") {
          return;
        }
        context.report({ node, messageId: "rawTextControl", data: { name } });
      },
    };
  },
});

/** Dashboard Oxlint rules that keep text boxes on the shared text controls. */
export default eslintCompatPlugin({
  meta: { name: "text-control" },
  rules: { "no-raw-text-control": noRawTextControlRule },
});
