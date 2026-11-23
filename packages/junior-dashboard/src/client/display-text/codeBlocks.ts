import { markdownNodes, parseMarkdown } from "@sentry/junior-plugin-api";
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

/**
 * A fenced code block at the start of a line: its `[start, end)` range in
 * the text, from the start of its first line, its language tag, and its code
 * with the fence indent removed, as CommonMark reads it.
 */
interface MarkdownFence {
  code: string;
  end: number;
  language?: string;
  start: number;
}

/** Return the fenced code blocks of Markdown text, in text order. */
export function markdownFences(text: string): MarkdownFence[] {
  return markdownNodes(parseMarkdown(text), ["code"]).flatMap(
    (node): MarkdownFence[] => {
      if (!node.position) return [];
      const fenceStart = node.position.start.offset ?? 0;
      const start = fenceStart - (node.position.start.column - 1);
      const fenced =
        text.startsWith("```", fenceStart) ||
        text.startsWith("~~~", fenceStart);
      // Only a fence with nothing but indent before it on its line counts.
      // An indented code block, or a fence after a list or quote marker,
      // stays in the prose.
      if (!fenced || text.slice(start, fenceStart).trim()) return [];
      return [
        {
          // The code ends with its final newline, as the fence holds it.
          code: node.value ? `${node.value}\n` : "",
          end: node.position.end.offset ?? text.length,
          language: node.lang ?? undefined,
          start,
        },
      ];
    },
  );
}

/** Parse transcript prose as Markdown or JSON while preserving fenced code. */
export function parseMarkdownBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let cursor = 0;
  for (const fence of markdownFences(text)) {
    const prose = text.slice(cursor, fence.start).trim();
    if (prose) blocks.push(proseBlock(prose));
    const language = fence.language
      ? normalizeLanguage(fence.language)
      : guessLanguage(fence.code);
    blocks.push({
      code: formatCodeBlock(fence.code, language),
      fenced: true,
      language,
    });
    cursor = fence.end;
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

function formatCodeBlock(code: string, language: BundledLanguage): string {
  return language === "json" ? (prettyJsonData(code) ?? code) : code;
}
