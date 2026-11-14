import path from "node:path";

import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

type Entry = {
  /** Repo-relative path of the module that exports `names`, without extension. */
  module?: string;
  names?: string[];
  /** Slack Web API methods, such as `chat.postMessage`. */
  slackMethods?: string[];
  /**
   * Repo-relative files that own the restricted calls, each with the reason
   * it cannot comply, such as owning the boundary.
   */
  allow: Array<{ file: string; reason: string }>;
  message: string;
};

type Options = {
  /** Import prefixes and the repo-relative directory each maps to. */
  aliases?: Record<string, string>;
  entries: Entry[];
};

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;

// Expression wrappers that keep the value of their operand.
const VALUE_WRAPPERS = new Set([
  "AwaitExpression",
  "ChainExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

function toPosix(file: string): string {
  return file.split(path.sep).join("/");
}

function staticString(node: ESTree.Node | undefined): string | null {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function staticName(node: ESTree.Node, computed: boolean): string | null {
  if (!computed && node.type === "Identifier") return node.name;
  return staticString(node);
}

/** A type-position reference, such as `typeof gateway.completeText`. */
function isTypePosition(node: ESTree.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (!current.type.startsWith("TS")) return false;
    if (!VALUE_WRAPPERS.has(current.type)) return true;
  }
  return false;
}

/** The call that `node` is the callee of, as in `f()`, `f<T>()`, or `a.f?.()`. */
function callOf(node: ESTree.Node): ESTree.CallExpression | undefined {
  let current = node;
  while (
    current.parent &&
    VALUE_WRAPPERS.has(current.parent.type) &&
    current.parent.type !== "AwaitExpression"
  ) {
    current = current.parent;
  }
  const parent = current.parent;
  return parent?.type === "CallExpression" && parent.callee === current
    ? parent
    : undefined;
}

const FUNCTIONS = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

/**
 * A call that only forwards the enclosing function's parameters, such as
 * `(params) => completeText(params)`. It exports the restricted function
 * under a new name.
 */
function isPassThrough(call: ESTree.CallExpression): boolean {
  let fn: ESTree.Node | null = call.parent;
  while (fn && !FUNCTIONS.has(fn.type)) fn = fn.parent;
  if (
    fn?.type !== "ArrowFunctionExpression" &&
    fn?.type !== "FunctionDeclaration" &&
    fn?.type !== "FunctionExpression"
  ) {
    return false;
  }
  const params = fn.params.map((param) =>
    param.type === "RestElement" ? param.argument : param,
  );
  const names = params.map((param) =>
    param.type === "Identifier" ? param.name : null,
  );
  return (
    names.every((name) => name !== null) &&
    call.arguments.length === names.length &&
    call.arguments.every((argument, index) => {
      const value =
        argument.type === "SpreadElement" ? argument.argument : argument;
      return value.type === "Identifier" && value.name === names[index];
    })
  );
}

/**
 * Report uses of functions and Slack Web API methods that only their owner
 * modules may call. Each function use resolves through scope analysis to its
 * import, so renamed, namespace, destructured, and dynamic imports resolve to
 * the same restricted function. Owners may only call the restricted function,
 * so they cannot hand it to another module under a new name.
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
        "Do not use {{subject}} here. {{message}} For a one-off exception, put `// oxlint-disable-next-line junior/restricted-call -- <reason>` on the line before it. Add a file to this entry's `allow` list in .oxlintrc.json only when it owns the boundary, with a `reason` that says why it cannot comply.",
      ownerLeak:
        "Only call {{subject}} here. Do not export, alias, destructure, or pass it: another module could then call it without this check. Wrap it in a function that applies the owner's rules instead.",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        required: ["entries"],
        properties: {
          aliases: {
            type: "object",
            additionalProperties: { type: "string" },
          },
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
                allow: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["file", "reason"],
                    properties: {
                      file: { type: "string" },
                      reason: { type: "string", minLength: 1 },
                    },
                  },
                },
                message: { type: "string" },
              },
            },
          },
        },
      },
    ],
  },
  create(context) {
    const [options] = context.options as [Options?];
    // Option paths are relative to the repo root, where oxlint runs.
    const file = toPosix(path.relative(context.cwd, context.filename));
    const entries = options?.entries ?? [];
    if (entries.length === 0) return {};
    const aliases = Object.entries(options?.aliases ?? {});

    const isOwner = (entry: Entry) =>
      entry.allow.some((owner) => owner.file === file);
    const moduleEntries = entries.filter((entry) => entry.module);
    const slackEntries = entries.flatMap((entry) =>
      (entry.slackMethods ?? []).map((method) => ({ entry, method })),
    );
    const guardedSlackEntry = slackEntries.find(
      ({ entry }) => !isOwner(entry),
    )?.entry;

    function report(node: ESTree.Node, subject: string, entry: Entry) {
      if (isOwner(entry)) {
        context.report({ node, messageId: "ownerLeak", data: { subject } });
        return;
      }
      context.report({
        node,
        messageId: "restricted",
        data: { subject, message: entry.message },
      });
    }

    // A use that is allowed: any use outside a type in a non-owner, or a
    // direct call in an owner.
    function reportUse(node: ESTree.Node, subject: string, entry: Entry) {
      const call = callOf(node);
      if (isOwner(entry) && call && !isPassThrough(call)) return;
      report(node, subject, entry);
    }

    function entryFor(specifier: string): Entry | undefined {
      let resolved = specifier;
      const alias = aliases.find(([prefix]) => specifier.startsWith(prefix));
      if (alias) {
        resolved = path.join(
          context.cwd,
          alias[1],
          specifier.slice(alias[0].length),
        );
      } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
        resolved = path.resolve(path.dirname(context.filename), specifier);
      }
      if (path.isAbsolute(resolved)) {
        resolved = toPosix(path.relative(context.cwd, resolved));
      }
      const id = resolved.replace(/\/$/, "").replace(SOURCE_EXTENSION, "");
      // Case-insensitive file systems resolve `Pi/Client` to `pi/client`.
      return moduleEntries.find(
        (entry) => entry.module?.toLowerCase() === id.toLowerCase(),
      );
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
          reportUse(parent, subjectOf(entry, name ?? "[computed]"), entry);
        }
        return;
      }
      if (parent.type === "VariableDeclarator" && parent.init === node) {
        if (parent.id.type === "ObjectPattern") {
          checkPattern(parent.id, entry);
        } else if (parent.id.type === "Identifier") {
          checkReferences(parent, (identifier) =>
            checkModuleValue(identifier, entry),
          );
        } else {
          report(node, subjectOf(entry, "*"), entry);
        }
        return;
      }
      report(node, subjectOf(entry, "*"), entry);
    }

    // `import(...)` and `require(...)` with a static specifier.
    function checkModuleLoad(node: ESTree.Node, source: ESTree.Node) {
      const specifier = staticString(source);
      const entry = specifier === null ? undefined : entryFor(specifier);
      if (!entry) return;
      if (node.type === "CallExpression") {
        checkModuleValue(node, entry);
      } else if (node.parent?.type === "AwaitExpression") {
        checkModuleValue(node.parent, entry);
      } else {
        // `.then(...)` hides which member it reads.
        report(node, subjectOf(entry, "*"), entry);
      }
    }

    function checkSlackUrl(node: ESTree.Node, text: string) {
      for (const { entry, method } of slackEntries) {
        if (!isOwner(entry) && text.includes(`api/${method}`)) {
          report(node, `Slack \`${method}\``, entry);
        }
      }
    }

    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        const entry = entryFor(node.source.value);
        if (!entry) return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") {
            // A namespace, or a default import that interop makes one.
            checkReferences(specifier, (identifier) =>
              checkModuleValue(identifier, entry),
            );
            continue;
          }
          if (specifier.importKind === "type") continue;
          const name = staticName(specifier.imported, false);
          if (name === null || !entry.names?.includes(name)) continue;
          checkReferences(specifier, (identifier) =>
            reportUse(identifier, subjectOf(entry, name), entry),
          );
        }
      },
      TSImportEqualsDeclaration(node) {
        if (node.importKind === "type") return;
        const reference = node.moduleReference;
        if (reference.type !== "TSExternalModuleReference") return;
        const entry = entryFor(reference.expression.value);
        if (!entry) return;
        checkReferences(node, (identifier) =>
          checkModuleValue(identifier, entry),
        );
      },
      ImportExpression(node) {
        checkModuleLoad(node, node.source);
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
      // The Slack client can be aliased or passed around, so a method
      // matches on its name, such as `postMessage`, on any object.
      MemberExpression(node) {
        const name = staticName(node.property, node.computed);
        if (name === null) {
          // `client.chat[method]` hides which method it calls.
          if (
            guardedSlackEntry &&
            node.object.type === "MemberExpression" &&
            staticName(node.object.property, node.object.computed) === "chat"
          ) {
            report(node, "a computed Slack `chat` method", guardedSlackEntry);
          }
          return;
        }
        if (name === "apiCall" && guardedSlackEntry && !callOf(node)) {
          report(node, "Slack `apiCall`", guardedSlackEntry);
          return;
        }
        for (const { entry, method } of slackEntries) {
          if (method.split(".").at(-1) === name) {
            reportUse(node, `Slack \`${method}\``, entry);
          }
        }
      },
      // A raw `fetch` to `https://slack.com/api/chat.postMessage`.
      Literal(node) {
        if (typeof node.value === "string") checkSlackUrl(node, node.value);
      },
      TemplateElement(node) {
        checkSlackUrl(node, node.value.raw);
      },
      Property(node) {
        if (node.parent.type !== "ObjectPattern") return;
        const name = staticName(node.key, node.computed);
        for (const { entry, method } of slackEntries) {
          if (method.split(".").at(-1) === name) {
            report(node, `Slack \`${method}\``, entry);
          }
        }
      },
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments[0]
        ) {
          checkModuleLoad(node, node.arguments[0]);
          return;
        }
        if (
          !guardedSlackEntry ||
          node.callee.type !== "MemberExpression" ||
          staticName(node.callee.property, node.callee.computed) !== "apiCall"
        ) {
          return;
        }
        const method = staticString(node.arguments[0]);
        if (method === null) {
          report(
            node,
            "Slack `apiCall` with a computed method",
            guardedSlackEntry,
          );
          return;
        }
        for (const { entry, method: restricted } of slackEntries) {
          if (method === restricted && !isOwner(entry)) {
            report(node, `Slack \`${restricted}\``, entry);
          }
        }
      },
    };
  },
});
