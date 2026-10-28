/**
 * Changing values in recorded requests, such as ids and clock times. This
 * copy has only the patterns. The service owns the placeholders.
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
   * of `git commit`, such as `[main (root-commit) a7a9f1d]`, and in the range
   * of `git push`, such as `a5fd79f..a73e959`, because seven hex digits can
   * also be a word.
   */
  gitCommit: String.raw`${NOT_AFTER_WORD}[0-9a-f]{40}(?![0-9A-Za-z])|(?<=\[[^\]\s]+ (?:\(root-commit\) )?)[0-9a-f]{7,12}(?=\])|${NOT_AFTER_WORD}[0-9a-f]{7,12}(?=\.\.\.?[0-9a-f]{7,12}(?![0-9A-Za-z]))|(?<=${NOT_AFTER_WORD}[0-9a-f]{7,12}\.\.\.?)[0-9a-f]{7,12}(?![0-9A-Za-z])`,
} as const;

/** Changing values by name. Each value is a regular expression source. */
export type ValuePatterns = Record<string, string>;
