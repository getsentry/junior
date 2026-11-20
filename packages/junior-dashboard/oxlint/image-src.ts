import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const EXTERNAL_URL = /^\s*(https?:)?\/\//i;
const IMAGE_ELEMENT = /^(img|source|.*Image)$/;

/** Return the JSX element name, with the last part of a member name such as `Avatar.Image`. */
function elementName(node: ESTree.JSXOpeningElement): string | undefined {
  if (node.name.type === "JSXIdentifier") return node.name.name;
  if (node.name.type === "JSXMemberExpression") return node.name.property.name;
  return undefined;
}

/** Return the text that a `src` value starts with, when the code sets it. */
function leadingText(value: ESTree.JSXAttribute["value"]): string | undefined {
  const node =
    value?.type === "JSXExpressionContainer" ? value.expression : value;
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral") {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/**
 * Keep dashboard images on the Junior image route or the same origin. A raw
 * external `src` sends the IP address and referrer of each viewer to that host.
 */
export const noRawExternalImageSrcRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Serve external images through the Junior image route, not from their own host.",
    },
    messages: {
      externalSrc:
        "Serve an external image through the Junior image route (`/api/images/...`), not from its own host. A raw external `{{attribute}}` sends the IP address and referrer of each viewer to that host. Use a path that the API returns, or a same-origin asset.",
    },
  },
  createOnce(context) {
    return {
      JSXOpeningElement(node) {
        const name = elementName(node);
        if (!name || !IMAGE_ELEMENT.test(name)) return;
        for (const attribute of node.attributes) {
          if (
            attribute.type !== "JSXAttribute" ||
            attribute.name.type !== "JSXIdentifier" ||
            (attribute.name.name !== "src" && attribute.name.name !== "srcSet")
          ) {
            continue;
          }
          const text = leadingText(attribute.value);
          if (text !== undefined && EXTERNAL_URL.test(text)) {
            context.report({
              node: attribute,
              messageId: "externalSrc",
              data: { attribute: attribute.name.name },
            });
          }
        }
      },
    };
  },
});

/** Dashboard Oxlint rule that keeps viewer requests off third-party image hosts. */
export default eslintCompatPlugin({
  meta: { name: "image-src" },
  rules: { "no-raw-external-image-src": noRawExternalImageSrcRule },
});
