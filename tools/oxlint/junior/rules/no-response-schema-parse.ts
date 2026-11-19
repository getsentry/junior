import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const parseMethods = new Set([
  "parse",
  "parseAsync",
  "safeParse",
  "safeParseAsync",
]);
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const schemaAlias = "@/api/schema";
const schemaDir = path.join(REPO_ROOT, "packages/junior/src/api/schema");

/** Tell if an import source names `api/schema.ts` or a file in `api/schema/`. */
function isResponseSchemaSource(source: string, filename: string): boolean {
  if (source === schemaAlias || source.startsWith(`${schemaAlias}/`)) {
    return true;
  }
  if (!source.startsWith(".")) return false;
  const resolved = path.resolve(path.dirname(filename), source);
  return (
    resolved === schemaDir || resolved.startsWith(`${schemaDir}${path.sep}`)
  );
}

function memberName(node: ESTree.MemberExpression): string | null {
  return !node.computed && node.property.type === "Identifier"
    ? node.property.name
    : null;
}

/**
 * Report a parse of an `api/schema` response schema. `jsonResponse` parses
 * every REST response against its schema, so a reader that parses the same
 * value first does the work twice.
 */
export const noResponseSchemaParseRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Parse an `api/schema` schema only in `jsonResponse`, or at a real input edge.",
    },
    messages: {
      responseSchemaParse:
        "Do not parse `{{name}}` here. `jsonResponse` parses the response. If this is a real edge, such as request input, a stored read, or plugin input, disable this rule on the line and name the edge.",
    },
  },
  create(context) {
    const schemas = new Set<string>();
    const namespaces = new Set<string>();
    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        if (!isResponseSchemaSource(node.source.value, context.filename)) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            namespaces.add(specifier.local.name);
          } else if (
            specifier.type === "ImportSpecifier" &&
            specifier.importKind !== "type"
          ) {
            schemas.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        const method = memberName(callee);
        if (!method || !parseMethods.has(method)) return;
        const target = callee.object;
        let name: string | null = null;
        if (target.type === "Identifier" && schemas.has(target.name)) {
          name = target.name;
        } else if (
          target.type === "MemberExpression" &&
          target.object.type === "Identifier" &&
          namespaces.has(target.object.name)
        ) {
          name = memberName(target);
        }
        if (name) {
          context.report({
            node: callee,
            messageId: "responseSchemaParse",
            data: { name },
          });
        }
      },
    };
  },
});
