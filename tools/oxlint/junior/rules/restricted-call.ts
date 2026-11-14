import fs from "node:fs";
import path from "node:path";

import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

type Entry = {
  /** Repo-relative path of the module that exports `names`, without extension. */
  module?: string;
  names?: string[];
  /** Slack Web API methods, such as `chat.postMessage`. */
  slackMethods?: string[];
  /** Repo-relative files that own the restricted calls. */
  allow: string[];
  message: string;
};

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;

// Expression wrappers that keep the value of their operand.
const VALUE_WRAPPERS = new Set([
  "AwaitExpression",
  "ChainExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

function toPosix(file: string): string {
  return file.split(path.sep).join("/");
}

function staticName(node: ESTree.Node, computed: boolean): string | null {
  if (!computed && node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return null;
}

/** A type-position reference, such as `typeof gateway.completeText`. */
function isTypePosition(node: ESTree.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (!current.type.startsWith("TS")) return false;
    if (!VALUE_WRAPPERS.has(current.type)) return true;
  }
  return false;
}

// `@/` maps to `<package>/src/`, as in each package's tsconfig `paths`.
function packageRoot(file: string): string {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) return path.dirname(file);
  }
}

/**
 * Report uses of functions and Slack Web API methods that only their owner
 * modules may call. Each function use resolves through scope analysis to its
 * import, so renamed, namespace, destructured, and dynamic imports resolve to
 * the same restricted function.
 */
export const restrictedCallRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Restrict calls to configured functions to the modules that own them.",
    },
    messages: {
      restricted:
        "Do not use {{subject}} here. {{message}} For a one-off exception, put `// oxlint-disable-next-line junior/restricted-call -- <reason>` on the line before it. Add a file to this entry's `allow` list in .oxlintrc.json only when that file takes ownership of the call.",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        required: ["entries"],
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["allow", "message"],
              properties: {
                module: { type: "string" },
                names: { type: "array", items: { type: "string" } },
                slackMethods: { type: "array", items: { type: "string" } },
                allow: { type: "array", items: { type: "string" } },
                message: { type: "string" },
              },
            },
          },
        },
      },
    ],
  },
  create(context) {
    const [options] = context.options as [{ entries: Entry[] }?];
    // Option paths are relative to the repo root, where oxlint runs.
    const file = toPosix(path.relative(context.cwd, context.filename));
    const entries = (options?.entries ?? []).filter(
      (entry) => !entry.allow.includes(file),
    );
    if (entries.length === 0) return {};

    const moduleEntries = entries.filter((entry) => entry.module);
    const slackEntries = entries.flatMap((entry) =>
      (entry.slackMethods ?? []).map((method) => ({
        entry,
        segments: method.split("."),
      })),
    );

    function report(node: ESTree.Node, subject: string, entry: Entry) {
      context.report({
        node,
        messageId: "restricted",
        data: { subject, message: entry.message },
      });
    }

    function entryFor(specifier: string): Entry | undefined {
      let resolved = specifier;
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        resolved = path.resolve(path.dirname(context.filename), specifier);
      } else if (specifier.startsWith("@/")) {
        resolved = path.join(
          packageRoot(context.filename),
          "src",
          specifier.slice(2),
        );
      }
      if (path.isAbsolute(resolved)) {
        resolved = toPosix(path.relative(context.cwd, resolved));
      }
      const id = resolved.replace(SOURCE_EXTENSION, "");
      return moduleEntries.find((entry) => entry.module === id);
    }

    const subjectOf = (entry: Entry, name: string) =>
      `\`${name}\` from \`${entry.module}\``;

    function checkReferences(
      declared: ESTree.Node,
      check: (identifier: ESTree.Node) => void,
    ) {
      for (const variable of context.sourceCode.getDeclaredVariables(
        declared,
      )) {
        for (const reference of variable.references) {
          if (reference.isRead() && !isTypePosition(reference.identifier)) {
            check(reference.identifier);
          }
        }
      }
    }

    function checkPattern(pattern: ESTree.ObjectPattern, entry: Entry) {
      for (const property of pattern.properties) {
        if (property.type === "RestElement") {
          report(property, subjectOf(entry, "..."), entry);
          continue;
        }
        const name = staticName(property.key, property.computed);
        if (name === null || entry.names?.includes(name)) {
          report(property, subjectOf(entry, name ?? "[computed]"), entry);
        }
      }
    }

    // `node` evaluates to the module namespace object. Follow it to the
    // member that it reads, or report it when it escapes.
    function checkModuleValue(node: ESTree.Node, entry: Entry) {
      const parent = node.parent;
      if (!parent) return;
      if (VALUE_WRAPPERS.has(parent.type)) {
        checkModuleValue(parent, entry);
        return;
      }
      if (parent.type === "MemberExpression" && parent.object === node) {
        const name = staticName(parent.property, parent.computed);
        if (name === null || entry.names?.includes(name)) {
          report(parent, subjectOf(entry, name ?? "[computed]"), entry);
        }
        return;
      }
      if (parent.type === "VariableDeclarator" && parent.init === node) {
        if (parent.id.type === "ObjectPattern") {
          checkPattern(parent.id, entry);
        } else {
          checkReferences(parent, (identifier) =>
            checkModuleValue(identifier, entry),
          );
        }
        return;
      }
      report(node, subjectOf(entry, "*"), entry);
    }

    function isSlackMember(node: ESTree.Node, segments: string[]): boolean {
      let current = node;
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        if (current.type !== "MemberExpression") return false;
        if (
          staticName(current.property, current.computed) !== segments[index]
        ) {
          return false;
        }
        current = current.object;
      }
      return true;
    }

    // `const { postMessage } = client.chat` or
    // `const { chat: { postMessage } } = client`.
    function isSlackDestructure(
      property: ESTree.Node,
      segments: string[],
    ): boolean {
      if (property.type !== "Property") return false;
      if (staticName(property.key, property.computed) !== segments.at(-1)) {
        return false;
      }
      const pattern = property.parent;
      if (pattern.type !== "ObjectPattern") return false;
      const holder = pattern.parent;
      const namespace = segments.slice(0, -1);
      if (holder.type === "VariableDeclarator" && holder.id === pattern) {
        return holder.init !== null && isSlackMember(holder.init, namespace);
      }
      if (holder.type === "AssignmentExpression" && holder.left === pattern) {
        return isSlackMember(holder.right, namespace);
      }
      return (
        holder.type === "Property" &&
        staticName(holder.key, holder.computed) === namespace.at(-1)
      );
    }

    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        const entry = entryFor(node.source.value);
        if (!entry) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            checkReferences(specifier, (identifier) =>
              checkModuleValue(identifier, entry),
            );
            continue;
          }
          if (
            specifier.type !== "ImportSpecifier" ||
            specifier.importKind === "type"
          ) {
            continue;
          }
          const name = staticName(specifier.imported, false);
          if (name === null || !entry.names?.includes(name)) continue;
          checkReferences(specifier, (identifier) =>
            report(identifier, subjectOf(entry, name), entry),
          );
        }
      },
      ImportExpression(node) {
        if (node.source.type !== "Literal") return;
        if (typeof node.source.value !== "string") return;
        const entry = entryFor(node.source.value);
        if (!entry) return;
        // `await import(...)` is the module namespace. Anything else, such
        // as `.then(...)`, hides which member it reads.
        if (node.parent.type === "AwaitExpression") {
          checkModuleValue(node.parent, entry);
        } else {
          report(node, subjectOf(entry, "*"), entry);
        }
      },
      ExportNamedDeclaration(node) {
        if (!node.source || node.exportKind === "type") return;
        const entry = entryFor(node.source.value);
        if (!entry) return;
        for (const specifier of node.specifiers) {
          const name = staticName(specifier.local, false);
          if (
            specifier.exportKind !== "type" &&
            name !== null &&
            entry.names?.includes(name)
          ) {
            report(specifier, subjectOf(entry, name), entry);
          }
        }
      },
      ExportAllDeclaration(node) {
        if (node.exportKind === "type") return;
        const entry = entryFor(node.source.value);
        if (entry) report(node, subjectOf(entry, "*"), entry);
      },
      MemberExpression(node) {
        for (const { entry, segments } of slackEntries) {
          if (isSlackMember(node, segments)) {
            report(node, `Slack \`${segments.join(".")}\``, entry);
          }
        }
      },
      Property(node) {
        for (const { entry, segments } of slackEntries) {
          if (isSlackDestructure(node, segments)) {
            report(node, `Slack \`${segments.join(".")}\``, entry);
          }
        }
      },
      CallExpression(node) {
        const [method] = node.arguments;
        if (
          node.callee.type !== "MemberExpression" ||
          staticName(node.callee.property, node.callee.computed) !==
            "apiCall" ||
          method?.type !== "Literal"
        ) {
          return;
        }
        for (const { entry, segments } of slackEntries) {
          if (method.value === segments.join(".")) {
            report(node, `Slack \`${segments.join(".")}\``, entry);
          }
        }
      },
    };
  },
});
