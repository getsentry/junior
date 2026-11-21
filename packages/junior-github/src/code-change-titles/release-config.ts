/**
 * A repository's changelog categories from `.github/release.yml`, the file
 * that GitHub release notes and Craft read. Craft adds `commit_patterns` to
 * each category. When the file has categories with patterns, they replace
 * the default categories, as in Craft.
 */
import { RE2JS } from "re2js";
import { parse as parseYaml } from "yaml";
import * as z from "zod";
import {
  DEFAULT_CODE_CHANGE_CATEGORIES,
  type CodeChangeCategory,
  type TitlePattern,
} from "./parse.js";

// Patterns come from any repository that Junior opens pull requests in, so
// they are untrusted. RE2 matches in time linear in the title, so no
// pattern can backtrack, such as `(a|aa)*b`. It rejects backreferences and
// lookarounds as syntax errors. These limits, with the title length limit
// in `parse.ts`, bound the work that one title can cause.
const MAX_CONFIG_LENGTH = 64 * 1024;
const MAX_CATEGORIES = 30;
const MAX_PATTERNS = 10;
const MAX_PATTERN_LENGTH = 200;

const releaseConfigSchema = z.object({
  changelog: z
    .object({
      categories: z
        .array(
          z.object({
            commit_patterns: z.array(z.string()).optional(),
            title: z.string().min(1),
          }),
        )
        .optional(),
    })
    .optional(),
});

function compilePattern(source: string): TitlePattern | undefined {
  if (source.length > MAX_PATTERN_LENGTH) return undefined;
  let regex: RE2JS;
  try {
    regex = RE2JS.compile(source, RE2JS.CASE_INSENSITIVE);
  } catch {
    // Craft skips an invalid pattern.
    return undefined;
  }
  const groups = regex.namedGroups();
  return (title) => {
    const match = regex.matcher(title);
    if (!match.find()) return undefined;
    return {
      scope:
        "scope" in groups ? (match.group("scope") ?? undefined) : undefined,
      type: "type" in groups ? (match.group("type") ?? undefined) : undefined,
    };
  };
}

/**
 * Return the changelog categories of a `.github/release.yml` text. A file
 * with no usable `commit_patterns`, or one that does not parse, gives the
 * default categories.
 */
export function parseReleaseCategories(
  text: string,
): readonly CodeChangeCategory[] {
  if (text.length > MAX_CONFIG_LENGTH) return DEFAULT_CODE_CHANGE_CATEGORIES;
  let raw: unknown;
  try {
    raw = parseYaml(text, { maxAliasCount: 100 });
  } catch {
    return DEFAULT_CODE_CHANGE_CATEGORIES;
  }
  const config = releaseConfigSchema.safeParse(raw);
  if (!config.success) return DEFAULT_CODE_CHANGE_CATEGORIES;
  const categories = (config.data.changelog?.categories ?? [])
    .slice(0, MAX_CATEGORIES)
    .map((category) => ({
      custom: true,
      patterns: (category.commit_patterns ?? [])
        .slice(0, MAX_PATTERNS)
        .map(compilePattern)
        .filter((pattern) => pattern !== undefined),
      title: category.title,
    }))
    .filter((category) => category.patterns.length > 0);
  return categories.length > 0 ? categories : DEFAULT_CODE_CHANGE_CATEGORIES;
}
