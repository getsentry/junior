import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
// Files that read Markdown with a regex since before the rule, with their
// count of such regexes. `baseline-growth:check` keeps it from growing.
const BASELINE_PATH = "scripts/regex-markdown-baseline.json";
const BASELINE = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, BASELINE_PATH), "utf8"),
) as Record<string, number>;

const EMPHASIS_MARKERS = ["*", "_", "~", "`"];

// The character classes of a regex source, such as `[*_~]`, without their
// brackets.
function characterClasses(pattern: string): string[] {
  const classes: string[] = [];
  let start: number | undefined;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      index += 1;
    } else if (char === "[" && start === undefined) {
      start = index + 1;
    } else if (char === "]" && start !== undefined) {
      classes.push(pattern.slice(start, index));
      start = undefined;
    }
  }
  return classes;
}

// A code fence, a link or image, or a class of three emphasis markers means
// the regex reads Markdown syntax.
function readsMarkdown(pattern: string): boolean {
  return (
    pattern.includes("```") ||
    pattern.includes("`{3}") ||
    pattern.includes("\\]\\(") ||
    characterClasses(pattern).some(
      (members) =>
        EMPHASIS_MARKERS.filter((marker) => members.includes(marker)).length >=
        3,
    )
  );
}

function stringValue(node: ESTree.Node | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

function isRegExpCall(node: ESTree.CallExpression | ESTree.NewExpression) {
  return node.callee.type === "Identifier" && node.callee.name === "RegExp";
}

/**
 * Ban regexes that read Markdown, such as ones that strip emphasis, code
 * fences, or links to get plain text. A regex misses nesting, escapes, and
 * code spans. Parse with `mdast-util-from-markdown` and read the text nodes.
 */
export const noRegexMarkdownRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Read Markdown with a Markdown parser, not a regex.",
    },
    messages: {
      noRegexMarkdown:
        "Parse Markdown with `mdast-util-from-markdown` (with the GFM extensions) and read the text of its nodes. Do not match Markdown syntax with a regex, and do not add to scripts/regex-markdown-baseline.json.",
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
      | { baseline?: Record<string, number> }
      | undefined;
    const file = path
      .relative(REPO_ROOT, context.filename)
      .replaceAll("\\", "/");
    const allowed = (options?.baseline ?? BASELINE)[file] ?? 0;
    const found: ESTree.Node[] = [];
    const check = (node: ESTree.Node, pattern: string | undefined) => {
      if (pattern !== undefined && readsMarkdown(pattern)) found.push(node);
    };
    const checkCall = (node: ESTree.CallExpression | ESTree.NewExpression) => {
      if (isRegExpCall(node)) check(node, stringValue(node.arguments[0]));
    };
    return {
      Literal(node) {
        if ("regex" in node && node.regex) check(node, node.regex.pattern);
      },
      CallExpression: checkCall,
      NewExpression: checkCall,
      // A baseline file may keep its old regexes, but not add one.
      "Program:exit"() {
        if (found.length <= allowed) return;
        for (const node of found) {
          context.report({ node, messageId: "noRegexMarkdown" });
        }
      },
    };
  },
});
