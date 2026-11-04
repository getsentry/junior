import type { BundledLanguage } from "shiki/bundle/web";

import { dashboardCodeLanguages } from "../code-languages";
import { detectOutputLanguage, prettyJsonData } from "../format";
import type { CodeBlock } from "../types";

// Shiki has no language detection, and agents often leave fences untagged.
// Only clear signals select a language, so prose in a fence stays plain.
const SCRIPT_PATTERN =
  /^javascript:|=>|\b(?:const|let|var)\s+[\w$]+\s*=|\bfunction\b\s*[\w$]*\s*\(|^\s*(?:import\s.+\sfrom\s|export\s+(?:(?:async|class|const|default|enum|function|interface|let|type|var)\s|[{*]))/m;
const PYTHON_PATTERN =
  /^\s*(?:(?:async\s+)?def\s+\w+\s*\(.*\)\s*(?:->.*)?:|class\s+\w+(?:\([^)]*\))?\s*:|from\s+[\w.]+\s+import\s|import\s+[\w.]+\s*$)/m;
const SHELL_PATTERN =
  /^\s*(?:\$\s|(?:bun|brew|cargo|cat|cd|cp|curl|docker|echo|export|gh|git|go|grep|kubectl|ls|make|mkdir|mv|npm|npx|pip|pnpm|rm|ssh|sudo|uv|wget|yarn)\s)/;

const LANGUAGE_ALIASES: Record<string, BundledLanguage> = {
  console: "shellscript",
  htm: "html",
  js: "javascript",
  jsonl: "json",
  md: "markdown",
  ndjson: "json",
  sh: "shellscript",
  text: "markdown",
  txt: "markdown",
  xml: "xml",
  yml: "yaml",
};

/** Parse transcript prose as Markdown or JSON while preserving fenced code. */
export function parseMarkdownBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  // The info string can hold more than the language, such as `c++` or
  // `js title="x"`. Only its first word names the language.
  const fence = /^([ \t]*)```([^\n`]*)\n([\s\S]*?)```/gm;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text))) {
    const prose = text.slice(cursor, match.index).trim();
    if (prose) blocks.push(proseBlock(prose));
    const tag = match[2]?.trim().split(/\s+/)[0];
    const code = stripFenceIndent(match[3] ?? "", match[1]?.length ?? 0);
    const language = tag ? normalizeLanguage(tag) : guessLanguage(code);
    blocks.push({
      code: formatCodeBlock(code, language),
      fenced: true,
      language,
    });
    cursor = match.index + match[0].length;
  }
  const rest = text.slice(cursor).trim();
  if (rest) blocks.push(proseBlock(rest));
  return blocks.length > 0 ? blocks : [proseBlock(text)];
}

function proseBlock(text: string): CodeBlock {
  const language = detectOutputLanguage(text);
  return { code: formatCodeBlock(text, language), fenced: false, language };
}

function normalizeLanguage(tag: string): BundledLanguage {
  const normalized = tag.toLowerCase();
  const candidate = LANGUAGE_ALIASES[normalized] ?? normalized;
  return Object.hasOwn(dashboardCodeLanguages, candidate)
    ? (candidate as BundledLanguage)
    : "markdown";
}

function guessLanguage(code: string): BundledLanguage {
  if (detectOutputLanguage(code) === "json") return "json";
  if (SCRIPT_PATTERN.test(code)) return "tsx";
  if (PYTHON_PATTERN.test(code)) return "python";
  if (SHELL_PATTERN.test(code)) return "shellscript";
  return "markdown";
}

// A fence in a list item is indented, and so are its code lines. Remove that
// indent, as CommonMark does.
function stripFenceIndent(code: string, indent: number): string {
  if (indent === 0) return code;
  return code
    .split("\n")
    .map((line) => {
      const lead = line.length - line.trimStart().length;
      return line.slice(Math.min(indent, lead));
    })
    .join("\n");
}

function formatCodeBlock(code: string, language: BundledLanguage): string {
  return language === "json" ? (prettyJsonData(code) ?? code) : code;
}
