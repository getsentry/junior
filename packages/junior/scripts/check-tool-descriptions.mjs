import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@typescript/typescript6";
import {
  createToolSourceIndex,
  readRepoToolSources,
} from "./tool-schema-ast.mjs";

// Tool descriptions say what a tool does and returns. Field meaning lives in
// `describe()` on the param. See policies/tool-design.md.
//
// 512 fits Anthropic's "3-4 sentences" guidance with room to spare and is half
// of OpenAI's hard 1,024-character limit on a function description.
export const MAX_TOOL_DESCRIPTION_CHARS = 512;
// No provider limits a param description. One or two sentences fit in 256.
export const MAX_PARAM_DESCRIPTION_CHARS = 256;

const BASELINE_RELATIVE_PATH =
  "packages/junior/scripts/tool-descriptions-baseline.txt";
const SUBJECT_PREFIX_CHARS = 48;

// Agents read this text as the fix instruction, so it names the fix and the
// shortcuts that only hide the problem.
const GUIDANCE = {
  "tool-description-length": `Cut the description to what the tool does and returns, and move field meaning into describe() on the param. Do not split it into promptGuidelines or a computed string to pass.`,
  "param-description-length": `Cut it to what the value is and its format or constraint. Move behavior that spans fields into fixed validation or a shorter cross-field note.`,
  "tool-description-names-param": `Move what the tool description says about this field into describe() on the param, and remove the field name from the tool description. Put a rule that ties two fields together on the field that depends on the other.`,
};

// Strip parentheses and type-only wrappers such as `as const` and `satisfies`.
function unwrap(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True when tool description text names an input field: the key in a code
 * span, or a snake_case key as a bare word. A plain word such as "query" in
 * prose is not a field reference.
 */
export function namesParam(text, key) {
  const escaped = escapeRegExp(key);
  if (new RegExp(`\`${escaped}(?![\\w-])`).test(text)) return true;
  return key.includes("_") && new RegExp(`\\b${escaped}\\b`).test(text);
}

function subjectOf(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUBJECT_PREFIX_CHARS
    ? `${flat.slice(0, SUBJECT_PREFIX_CHARS)}…`
    : flat;
}

/**
 * Collect description violations as baseline signatures:
 * `path<TAB>rule<TAB>subject`. A description built at runtime (for example by
 * a render function) has no static text and is skipped.
 */
export function collectToolDescriptionIssues(files, packageSrcRoots = {}) {
  const index = createToolSourceIndex(files, packageSrcRoots);

  // Fold a string expression to its static text. `complete` is false when a
  // part could not be resolved, so the text is a lower bound.
  function staticText(filePath, input, depth = 0) {
    const unknown = { text: "", complete: false };
    const node = unwrap(input);
    if (!node || depth > 8) return unknown;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return { text: node.text, complete: true };
    }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      let complete = true;
      for (const span of node.templateSpans) {
        const part = staticText(filePath, span.expression, depth + 1);
        text += part.text + span.literal.text;
        complete &&= part.complete;
      }
      return { text, complete };
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = staticText(filePath, node.left, depth + 1);
      const right = staticText(filePath, node.right, depth + 1);
      return {
        text: left.text + right.text,
        complete: left.complete && right.complete,
      };
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "join"
    ) {
      let arrayFile = filePath;
      let array = unwrap(node.expression.expression);
      if (ts.isIdentifier(array)) {
        const found = index.lookup(filePath, array.text)?.[0];
        if (found) [arrayFile, array] = [found.filePath, unwrap(found.node)];
      }
      if (!ts.isArrayLiteralExpression(array)) return unknown;
      const separator = node.arguments[0]
        ? staticText(filePath, node.arguments[0], depth + 1)
        : { text: ",", complete: true };
      const parts = array.elements.map((element) =>
        staticText(arrayFile, element, depth + 1),
      );
      return {
        text: parts.map((part) => part.text).join(separator.text),
        complete: separator.complete && parts.every((part) => part.complete),
      };
    }
    if (ts.isIdentifier(node)) {
      const found = index.lookup(filePath, node.text)?.[0];
      if (found && !ts.isFunctionLike(found.node)) {
        return staticText(found.filePath, found.node, depth + 1);
      }
    }
    return unknown;
  }

  const issues = new Set();
  for (const { filePath, properties } of index.toolDefinitions()) {
    const keys = new Set();
    const inputSchema = properties.get("inputSchema");
    if (inputSchema) {
      index.walkSchema(filePath, inputSchema, {
        onKey: (_file, _property, key) => keys.add(key),
        onDescribe: (describeFile, call, key) => {
          const { text } = staticText(describeFile, call.arguments[0]);
          if (text.length > MAX_PARAM_DESCRIPTION_CHARS) {
            issues.add(
              `${describeFile}\tparam-description-length\t${key ?? "?"}: ${subjectOf(text)}`,
            );
          }
        },
      });
    }

    const { text } = staticText(filePath, properties.get("description"));
    if (!text) continue;
    const subject = subjectOf(text);
    if (text.length > MAX_TOOL_DESCRIPTION_CHARS) {
      issues.add(`${filePath}\ttool-description-length\t${subject}`);
    }
    for (const key of [...keys].sort()) {
      if (namesParam(text, key)) {
        issues.add(
          `${filePath}\ttool-description-names-param\t${key}: ${subject}`,
        );
      }
    }
  }
  return [...issues].sort();
}

/** Parse the approved baseline, ignoring blank lines and comments. */
export function parseBaseline(text) {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#")),
    ),
  ].sort();
}

function issueMessage(entry) {
  const [filePath, rule, subject] = entry.split("\t");
  const limit =
    rule === "tool-description-length"
      ? ` (max ${MAX_TOOL_DESCRIPTION_CHARS} chars)`
      : rule === "param-description-length"
        ? ` (max ${MAX_PARAM_DESCRIPTION_CHARS} chars)`
        : "";
  return `${filePath}: ${rule}${limit}: "${subject}" ${GUIDANCE[rule]}`;
}

/** Compare current issues with the baseline: new issues and stale entries. */
export function diffBaseline(current, baseline) {
  const currentSet = new Set(current);
  const baselineSet = new Set(baseline);
  return {
    unexpected: current.filter((entry) => !baselineSet.has(entry)),
    stale: baseline.filter((entry) => !currentSet.has(entry)),
  };
}

/** Check that no new tool description issues land in repo packages. */
export async function checkRepoToolDescriptions(repoRoot) {
  const { files, packageSrcRoots } = await readRepoToolSources(repoRoot);
  const current = collectToolDescriptionIssues(files, packageSrcRoots);
  const baseline = parseBaseline(
    await fs.readFile(path.join(repoRoot, BASELINE_RELATIVE_PATH), "utf8"),
  );
  const { unexpected, stale } = diffBaseline(current, baseline);
  return [
    ...unexpected.map(issueMessage),
    ...stale.map(
      (entry) =>
        `${entry.split("\t")[0]}: stale entry; remove it from ${BASELINE_RELATIVE_PATH}: ${entry.split("\t").slice(1).join(" ")}`,
    ),
  ];
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const repoRoot = path.resolve(path.dirname(scriptPath), "../../..");
  const errors = await checkRepoToolDescriptions(repoRoot);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}
