import type { BundledLanguage } from "shiki/bundle/web";

const SCRIPT_PATTERN =
  /^javascript:|=>|\b(?:const|let|var)\s+[\w$]+\s*=|\bfunction\b\s*[\w$]*\s*\(|^\s*(?:import\s.+\sfrom\s|export\s+(?:default|const|function|type|interface)\b)/m;
const PYTHON_PATTERN =
  /^\s*(?:(?:async\s+)?def\s+\w+\s*\(.*\)\s*(?:->.*)?:|class\s+\w+.*:|from\s+[\w.]+\s+import\s|import\s+[\w.]+\s*$)/m;
const SHELL_PATTERN =
  /^\s*(?:\$\s|(?:bun|brew|cargo|cat|cd|cp|curl|docker|echo|export|gh|git|go|grep|kubectl|ls|make|mkdir|mv|npm|npx|pip|pnpm|rm|ssh|sudo|uv|wget|yarn)\s)/;

/**
 * Guess the language of a fenced code block that has no language tag.
 *
 * Agents often leave fences untagged, and Shiki has no auto-detection. Only
 * clear signals select a language. Anything else returns undefined and
 * renders as plain text, so prose in a fence is not colored as code.
 */
export function guessFenceLanguage(code: string): BundledLanguage | undefined {
  if (SCRIPT_PATTERN.test(code)) return "tsx";
  if (PYTHON_PATTERN.test(code)) return "python";
  if (SHELL_PATTERN.test(code)) return "shellscript";
  return undefined;
}
