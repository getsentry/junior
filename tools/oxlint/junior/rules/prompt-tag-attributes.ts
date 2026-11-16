import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { staticString } from "../prompt-tag-patterns.ts";

/** Attribute names that each file may still write, by file and tag. */
export type PromptTagAttributeBaseline = Record<
  string,
  Record<string, string[]>
>;

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
/** Repository path of the attribute ratchet. */
export const BASELINE_PATH = "tools/oxlint/junior/prompt-tag-attributes.json";

/** Read the attribute ratchet. */
export function readBaseline(): PromptTagAttributeBaseline {
  return JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, BASELINE_PATH), "utf8"),
  ) as PromptTagAttributeBaseline;
}

const BASELINE = readBaseline();
// Baseline key for the attributes of a tag whose name code computes.
const COMPUTED_TAG = "*";

// Index of the attributes argument of each tag writer.
const WRITERS = new Map([
  ["renderEmptyTag", 1],
  ["renderInlineTag", 2],
  ["renderTag", 1],
  ["renderUntrustedTag", 1],
]);

function writerName(node: ESTree.CallExpression) {
  return node.callee.type === "Identifier" ? node.callee.name : undefined;
}

// A tag writer such as `renderUntrustedTag` passes its own attributes
// parameter on; its callers are checked.
function insideWriter(node: ESTree.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "FunctionDeclaration") {
      return WRITERS.has(current.id?.name ?? "");
    }
  }
  return false;
}

// Module constants such as `const PLAN_DELTA_TAG = "plan-delta"`.
function stringConstants(program: ESTree.Program): Map<string, string> {
  const constants = new Map<string, string>();
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    if (declaration.kind !== "const") continue;
    for (const declarator of declaration.declarations) {
      const value = staticString(declarator.init);
      if (declarator.id.type === "Identifier" && value !== undefined) {
        constants.set(declarator.id.name, value);
      }
    }
  }
  return constants;
}

function attributeNames(node: ESTree.ObjectExpression) {
  const names: string[] = [];
  for (const property of node.properties) {
    if (property.type !== "Property" || property.computed) return undefined;
    const key = property.key;
    if (key.type === "Identifier") names.push(key.name);
    else if (key.type === "Literal" && typeof key.value === "string") {
      names.push(key.value);
    } else return undefined;
  }
  return names;
}

/**
 * Ratchet prompt tag attributes. A tag holds facts as plain lines in its
 * body; the attributes that remain are listed by file and tag in
 * prompt-tag-attributes.json, with `*` for a tag name that code computes. A
 * new attribute fails, and a listed attribute that the file no longer writes
 * fails, so the list only shrinks.
 */
export const promptTagAttributesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Allow prompt tag attributes only where prompt-tag-attributes.json lists them.",
    },
    messages: {
      newAttribute:
        "`{{tag}}` may not take the attribute `{{attribute}}` in this file. Put the fact on a plain line in the tag body. Do not add to tools/oxlint/junior/prompt-tag-attributes.json.",
      staleAttribute:
        "This file no longer writes `{{attribute}}` on `{{tag}}`. Remove it from tools/oxlint/junior/prompt-tag-attributes.json.",
      literalAttributes:
        "Pass prompt tag attributes as an object literal with literal names, so the attribute ratchet can check them.",
    },
    schema: [
      {
        type: "object",
        properties: { baseline: { type: "object" } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] as
      | { baseline?: PromptTagAttributeBaseline }
      | undefined;
    const file = path
      .relative(REPO_ROOT, context.filename)
      .replaceAll("\\", "/");
    const allowed = (options?.baseline ?? BASELINE)[file] ?? {};
    const used = new Map<string, Set<string>>();
    let constants: Map<string, string> | undefined;
    let program: ESTree.Program | undefined;
    return {
      Program(node) {
        program = node;
      },
      CallExpression(node) {
        const index = WRITERS.get(writerName(node) ?? "");
        const attributes =
          index === undefined ? undefined : node.arguments[index];
        if (attributes === undefined) return;
        if (attributes.type !== "ObjectExpression") {
          if (attributes.type === "Identifier" && insideWriter(node)) return;
          context.report({ node: attributes, messageId: "literalAttributes" });
          return;
        }
        if (attributes.properties.length === 0) return;
        const nameNode = node.arguments[0];
        constants ??= program ? stringConstants(program) : new Map();
        const tag =
          staticString(nameNode) ??
          (nameNode?.type === "Identifier"
            ? constants.get(nameNode.name)
            : undefined) ??
          COMPUTED_TAG;
        const names = attributeNames(attributes);
        if (names === undefined) {
          context.report({ node: attributes, messageId: "literalAttributes" });
          return;
        }
        const tagUsed = used.get(tag) ?? new Set<string>();
        used.set(tag, tagUsed);
        for (const attribute of names) {
          tagUsed.add(attribute);
          if (!allowed[tag]?.includes(attribute)) {
            context.report({
              node: attributes,
              messageId: "newAttribute",
              data: { tag, attribute },
            });
          }
        }
      },
      "Program:exit"(node) {
        for (const [tag, attributes] of Object.entries(allowed)) {
          for (const attribute of attributes) {
            if (used.get(tag)?.has(attribute)) continue;
            context.report({
              node,
              messageId: "staleAttribute",
              data: { tag, attribute },
            });
          }
        }
      },
    };
  },
});
