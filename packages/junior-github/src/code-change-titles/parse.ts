/**
 * Split a pull request title into the parts that the Inbox shows: the text,
 * the change type, the scope, and the breaking marker. The rules follow
 * Craft's changelog categories (`getsentry/craft` `src/utils/changelog.ts`),
 * so a card names a change the way its release notes will.
 */
import type { InboxItemSubjectTitleParts } from "@sentry/junior-plugin-api";

/** The `type` and `scope` groups of a title pattern's match. */
export interface TitlePatternMatch {
  scope?: string | undefined;
  type?: string | undefined;
}

/** A compiled title pattern: the groups of its first match, if any. */
export type TitlePattern = (title: string) => TitlePatternMatch | undefined;

/** One changelog category: its title and its compiled title patterns. */
export interface CodeChangeCategory {
  /** True for a category from `.github/release.yml`. */
  custom: boolean;
  patterns: TitlePattern[];
  title: string;
}

// The default patterns are this file's own, so the built-in engine runs
// them. Repository patterns use RE2 (`release-config.ts`).
function nativePattern(source: string): TitlePattern {
  const regex = new RegExp(source, "i");
  return (title) => {
    const match = regex.exec(title);
    return match
      ? { scope: match.groups?.["scope"], type: match.groups?.["type"] }
      : undefined;
  };
}

function defaultCategory(title: string, sources: string[]): CodeChangeCategory {
  return { custom: false, patterns: sources.map(nativePattern), title };
}

/** Craft's `DEFAULT_RELEASE_CONFIG` categories, in match order. */
export const DEFAULT_CODE_CHANGE_CATEGORIES: readonly CodeChangeCategory[] = [
  defaultCategory("Breaking Changes", [
    String.raw`^(?<type>\w+(?:\((?<scope>[^)]+)\))?!:\s*)`,
  ]),
  defaultCategory("Security", [
    String.raw`^(?<type>security(?:\((?<scope>[^)]+)\))?!?:\s*)`,
  ]),
  defaultCategory("New Features", [
    String.raw`^(?<type>feat(?:\((?<scope>[^)]+)\))?!?:\s*)`,
  ]),
  defaultCategory("Bug Fixes", [
    String.raw`^(?<type>fix(?:\((?<scope>[^)]+)\))?!?:\s*)`,
    String.raw`^Revert "`,
  ]),
  defaultCategory("Documentation", [
    String.raw`^(?<type>docs?(?:\((?<scope>[^)]+)\))?!?:\s*)`,
  ]),
  defaultCategory("Internal Changes", [
    String.raw`^(?<type>(?:build|refactor|meta|chore|ci|ref|perf|tests?|style)(?:\((?<scope>[^)]+)\))?!?:\s*)`,
  ]),
];

const TYPE_WORDS: Record<string, string> = {
  build: "Build",
  chore: "Chore",
  ci: "CI",
  doc: "Docs",
  docs: "Docs",
  feat: "Feature",
  fix: "Fix",
  meta: "Meta",
  perf: "Perf",
  ref: "Refactor",
  refactor: "Refactor",
  revert: "Revert",
  security: "Security",
  style: "Style",
  test: "Test",
  tests: "Test",
};

const BREAKING = /^\w+(?:\([^)]+\))?!:/;
const REVERT = /^Revert "/i;
const PULL_REQUEST_SUFFIX = /\s*\(#\d+\)$/;

/** GitHub titles are at most 256 characters, so this bounds regex work. */
const MAX_TITLE_LENGTH = 256;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A custom category title as one word pill, without emoji or padding. */
function categoryWord(title: string): string | undefined {
  const word = title
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .trim();
  // The breaking marker already shows a breaking change.
  return word && !/^breaking\b/i.test(word) ? word : undefined;
}

function typeWord(
  category: CodeChangeCategory,
  token: string | undefined,
  title: string,
): string | undefined {
  const known = token ? TYPE_WORDS[token.toLowerCase()] : undefined;
  if (known) return known;
  if (!token && REVERT.test(title)) return "Revert";
  return category.custom ? categoryWord(category.title) : undefined;
}

function firstMatch(
  title: string,
  categories: readonly CodeChangeCategory[],
): { category: CodeChangeCategory; match: TitlePatternMatch } | undefined {
  for (const category of categories) {
    for (const pattern of category.patterns) {
      const match = pattern(title);
      if (match) return { category, match };
    }
  }
  return undefined;
}

/**
 * Return the title parts of a pull request title, or undefined when the
 * title has no conventional prefix and no breaking marker. The first
 * matching category wins, as in Craft.
 */
export function parseCodeChangeTitle(
  title: string,
  categories: readonly CodeChangeCategory[] = DEFAULT_CODE_CHANGE_CATEGORIES,
): InboxItemSubjectTitleParts | undefined {
  const bounded = title.slice(0, MAX_TITLE_LENGTH);
  const breaking = BREAKING.test(bounded);
  // A breaking title that no repo category matches still loses its prefix.
  const found =
    firstMatch(bounded, categories) ??
    (breaking
      ? firstMatch(bounded, DEFAULT_CODE_CHANGE_CATEGORIES.slice(0, 1))
      : undefined);
  if (!found) return undefined;
  const prefix = found.match.type;
  const token = prefix ? /^\w+/.exec(prefix)?.[0] : undefined;
  // A repository pattern need not be anchored, so strip the type only where
  // it leads the title.
  const leads = prefix !== undefined && bounded.startsWith(prefix);
  const rest = (leads ? title.slice(prefix.length) : title)
    .replace(PULL_REQUEST_SUFFIX, "")
    .trim();
  const type = typeWord(found.category, token, bounded);
  const scope = found.match.scope?.trim();
  return {
    text: rest ? capitalize(rest) : title,
    ...(type ? { type } : undefined),
    ...(scope ? { scope } : undefined),
    ...(breaking ? { breaking: true } : undefined),
  };
}
