import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const toolConstructors = new Set(["definePluginTool", "zodTool"]);

function keyName(property: ESTree.Node): string | null {
  if (property.type !== "Property" || property.computed) return null;
  if (property.key.type === "Identifier") return property.key.name;
  return property.key.type === "Literal" &&
    typeof property.key.value === "string"
    ? property.key.value
    : null;
}

function property(
  node: ESTree.Node | undefined,
  name: string,
): ESTree.Node | undefined {
  if (node?.type !== "ObjectExpression") return undefined;
  const match = node.properties.find((item) => keyName(item) === name);
  return match?.type === "Property" ? match.value : undefined;
}

/** Return the tool definition object that contains a node, if any. */
function enclosingToolDefinition(
  node: ESTree.Node,
): ESTree.ObjectExpression | undefined {
  let child: ESTree.Node = node;
  let current = node.parent;
  while (current) {
    if (
      current.type === "CallExpression" &&
      current.callee.type === "Identifier" &&
      toolConstructors.has(current.callee.name) &&
      current.arguments[0] === child &&
      child.type === "ObjectExpression"
    ) {
      return child;
    }
    child = current;
    current = current.parent;
  }
  return undefined;
}

/**
 * Reject `objectAnnotations` in a plugin tool that declares
 * `readOnlyHint: true`. An Annotation marks work that a Conversation did, such
 * as a created or changed object. A lookup does not link the object.
 */
export const noReadOnlyObjectAnnotationsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `objectAnnotations` in plugin tools that declare `readOnlyHint: true`.",
    },
    messages: {
      readOnly:
        "A read-only tool must not return `objectAnnotations`. An Annotation marks a change that the Conversation made, not an object that it read. Remove the field, or set `readOnlyHint: false` if the tool changes the object. Core rejects the result at runtime.",
    },
  },
  create(context) {
    return {
      Property(node) {
        if (keyName(node) !== "objectAnnotations") return;
        const definition = enclosingToolDefinition(node);
        const hint = property(
          property(definition, "annotations"),
          "readOnlyHint",
        );
        if (hint?.type === "Literal" && hint.value === true) {
          context.report({ node, messageId: "readOnly" });
        }
      },
    };
  },
});
