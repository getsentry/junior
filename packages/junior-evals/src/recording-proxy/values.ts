/**
 * Changing values in recorded requests, such as ids and clock times.
 *
 * A rule names the values that change from run to run. The proxy handles
 * them in two directions:
 *
 * - The key sees each value as `<<name>>`, so two runs with other ids or
 *   times send the same request.
 * - A response often repeats a value of its request, for example when the
 *   model archives the memory with id `<<uuid>>`. When the proxy records a
 *   response, it writes each value of the request as `<<name:n>>`, the n-th
 *   value of that name in the request. On replay, it writes back the n-th
 *   value of the current request. So a replayed response uses the ids of
 *   this run, not the ids of the recording run.
 *
 * A value that the response makes itself, such as a date that the model
 * calculates, stays as it was recorded.
 */

/**
 * Lookbehind: the value does not continue a word or number. The proxy
 * matches values in JSON text, where `\nab12` is a newline and then
 * `ab12`. So a letter after a backslash, such as the `n` of `\n`, does not
 * count as a word. Use it in a pattern that starts with a letter or digit.
 */
export const NOT_AFTER_WORD = String.raw`(?<!(?:^|[^\\])[0-9A-Za-z])`;

/**
 * Patterns for common changing values. Use them in `values` of a rule. Each
 * pattern is a regular expression source.
 */
export const VALUE_PATTERNS = {
  /** A UUID, also inside a name such as `junior-ws-<uuid>`. */
  uuid: String.raw`${NOT_AFTER_WORD}[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Za-z])`,
  /**
   * An ISO time, with `T` or a space, with or without seconds, and in UTC,
   * with an offset, or in local time.
   */
  isoTime: String.raw`(?<![\d-])\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}| ?UTC)?(?![\d:])`,
  /** An ISO date, such as `2026-10-07`. */
  date: String.raw`(?<![\d-])\d{4}-\d{2}-\d{2}(?![\d-])`,
  /**
   * Unix milliseconds from 2023 to 2033. Unix seconds, such as Slack
   * timestamps, do not match.
   */
  epochMs: String.raw`(?<!\d)1[789]\d{11}(?!\d)`,
  /**
   * A SHA-256 hex digest. Ids that the product hashes from other changing
   * values, such as attachment ids, change with them.
   */
  sha256: String.raw`${NOT_AFTER_WORD}[0-9a-f]{64}(?![0-9A-Za-z])`,
  /**
   * A git commit id. Its hash covers the commit time, so it changes on each
   * run. A full id has 40 hex digits. A short id only counts in the output
   * of `git commit`, such as `[main (root-commit) a7a9f1d]`, because seven
   * hex digits can also be a word.
   */
  gitCommit: String.raw`${NOT_AFTER_WORD}[0-9a-f]{40}(?![0-9A-Za-z])|(?<=\[[^\]\s]+ (?:\(root-commit\) )?)[0-9a-f]{7,12}(?=\])`,
} as const;

/** Changing values by name. Each value is a regular expression source. */
export type ValuePatterns = Record<string, string>;

/** The values of one request, by name, in the order of the request. */
export type RequestValues = Map<string, string[]>;

interface CompiledValues {
  names: string[];
  /** One expression for all patterns, with one group per name. */
  pattern: RegExp;
  /** The index of the group of each name. */
  groups: number[];
}

const compiled = new WeakMap<ValuePatterns, CompiledValues>();

/** The number of capturing groups in a pattern. */
const groupCount = (source: string) =>
  new RegExp(`${source}|`).exec("")!.length - 1;

function compile(patterns: ValuePatterns): CompiledValues {
  const cached = compiled.get(patterns);
  if (cached) return cached;
  const names = Object.keys(patterns);
  const groups: number[] = [];
  let next = 1;
  for (const name of names) {
    groups.push(next);
    next += 1 + groupCount(patterns[name]!);
  }
  const result = {
    names,
    // Earlier names win when two patterns match at the same place.
    pattern: new RegExp(
      names.map((name) => `(${patterns[name]})`).join("|"),
      "g",
    ),
    groups,
  };
  compiled.set(patterns, result);
  return result;
}

/**
 * Replace each changing value in `text` with `<<name>>`. Returns the text
 * and the values in their order. With no patterns, nothing changes.
 */
export function extractValues(
  text: string,
  patterns: ValuePatterns | undefined,
): { text: string; values: RequestValues } {
  const values: RequestValues = new Map();
  if (!patterns || Object.keys(patterns).length === 0) {
    return { text, values };
  }
  const { names, pattern, groups } = compile(patterns);
  const result = text.replace(pattern, (...match: unknown[]) => {
    const index = groups.findIndex((group) => match[group] !== undefined);
    const name = names[index]!;
    const list = values.get(name) ?? [];
    list.push(match[0] as string);
    values.set(name, list);
    return `<<${name}>>`;
  });
  return { text: result, values };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Write each value of the request that a recorded response repeats as
 * `<<name:n>>`. A value is replaced only where it is not part of a longer
 * word or number.
 */
export function templateValues(text: string, values: RequestValues): string {
  const placeholders = new Map<string, string>();
  for (const [name, list] of values) {
    list.forEach((value, index) => {
      if (!placeholders.has(value)) {
        placeholders.set(value, `<<${name}:${index + 1}>>`);
      }
    });
  }
  if (placeholders.size === 0) return text;
  // Longer values first, so a date never replaces part of a time.
  const alternatives = [...placeholders.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escape);
  const pattern = new RegExp(
    `${NOT_AFTER_WORD}(?:${alternatives.join("|")})(?![0-9A-Za-z])`,
    "g",
  );
  return text.replace(pattern, (value) => placeholders.get(value)!);
}

/**
 * Write back the values of the current request into a recorded response.
 * This undoes `templateValues()` with the values of this run.
 */
export function fillValues(text: string, values: RequestValues): string {
  return text.replace(
    /<<([^<>:\s]+):(\d+)>>/g,
    (placeholder, name: string, index: string) =>
      values.get(name)?.[Number(index) - 1] ?? placeholder,
  );
}
