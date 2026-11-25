import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

// Redirects send the reader on; no menu shows them.
const REDIRECT_ELEMENTS = new Set(["Navigate"]);

/** Return the JSX element name, with the last part of a member name. */
function elementName(node: ESTree.JSXOpeningElement): string | undefined {
  if (node.name.type === "JSXIdentifier") return node.name.name;
  if (node.name.type === "JSXMemberExpression") return node.name.property.name;
  return undefined;
}

/** True when the value is a dashboard path that the code spells out. */
function literalPath(node: ESTree.Node | null | undefined): boolean {
  if (node?.type === "JSXExpressionContainer")
    return literalPath(node.expression);
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value.startsWith("/");
  }
  if (node?.type === "TemplateLiteral") {
    return node.quasis[0]?.value.cooked?.startsWith("/") ?? false;
  }
  return false;
}

function propertyName(key: ESTree.Node, computed: boolean): string | undefined {
  if (computed) return undefined;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

/**
 * Make every dashboard page that a link names come from `navPages.ts`. The
 * command palette lists every page there, so a link with its own path is a
 * page that the palette cannot find.
 */
export const listedPagePathRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Link to dashboard pages from navPages.ts, so the command palette lists them.",
    },
    messages: {
      literalPath:
        "Take this page from `NAV_PAGES` in `src/client/navPages.ts`, or add it there. The command palette lists every page in it, so a link with its own path is a page that ⌘K cannot find. Build record paths, such as one Conversation, with their path helper.",
    },
  },
  createOnce(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "to") {
          return;
        }
        const element = node.parent;
        if (element.type !== "JSXOpeningElement") return;
        const name = elementName(element);
        if (name && REDIRECT_ELEMENTS.has(name)) return;
        if (literalPath(node.value)) {
          context.report({ node, messageId: "literalPath" });
        }
      },
      Property(node) {
        if (node.parent.type !== "ObjectExpression") return;
        if (propertyName(node.key, node.computed) !== "to") return;
        if (!literalPath(node.value)) return;
        context.report({ node, messageId: "literalPath" });
      },
    };
  },
});

/** Dashboard Oxlint rule that keeps every linked page in the command palette. */
export default eslintCompatPlugin({
  meta: { name: "nav-pages" },
  rules: { "listed-page-path": listedPagePathRule },
});
