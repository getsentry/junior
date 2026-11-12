import { defineRule } from "@oxlint/plugins";

/**
 * Require `import * as z from "zod"`. esbuild cannot tree-shake the named `z`
 * export, so one named import anywhere in the dashboard graph adds every zod
 * locale (about 250 KB) to the browser bundle.
 */
export const zodNamespaceImportRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Require `import * as z from "zod"` instead of the named `z` export.',
    },
    messages: {
      namespaceImport:
        'Use `import * as z from "zod"`. esbuild cannot tree-shake the named `z` export, so it adds every zod locale (about 250 KB) to the dashboard browser bundle.',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        // Type-only imports are erased, so they never reach the bundle.
        if (node.source.value !== "zod" || node.importKind === "type") return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.importKind !== "type" &&
            specifier.imported.type === "Identifier" &&
            specifier.imported.name === "z"
          ) {
            context.report({ node: specifier, messageId: "namespaceImport" });
          }
        }
      },
    };
  },
});
