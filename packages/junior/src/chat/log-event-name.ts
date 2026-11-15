/**
 * Compile-time shape of a log event name.
 *
 * An event name is two or more dot-separated segments. A segment starts with
 * a-z, then has only a-z, 0-9, and `_`, and does not end with `_`. This
 * matches what `normalizeEventName` accepts. The last segment is an observed
 * outcome, not a base verb or a direction. Lowercase dotted names let one
 * telemetry query match every event under a prefix.
 *
 * `tsc` checks each literal, each member of a literal union, and each
 * template literal whose holes are literal unions. It rejects a wide `string`
 * and template literals with `string` or `number` holes, because their value
 * is unknown. Narrow a runtime name to a declared union of names.
 */

type LowerLetter =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z";
type SegmentChar =
  | LowerLetter
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "_";

type IsSegmentTail<S extends string> = S extends `${infer C}${infer Rest}`
  ? C extends SegmentChar
    ? IsSegmentTail<Rest>
    : false
  : true;

type IsSegment<S extends string> = S extends `${string}_`
  ? false
  : S extends `${infer C}${infer Rest}`
    ? C extends LowerLetter
      ? IsSegmentTail<Rest>
      : false
    : false;

type IsSegmentList<S extends string> = S extends `${infer Head}.${infer Tail}`
  ? IsSegment<Head> extends true
    ? IsSegmentList<Tail>
    : false
  : IsSegment<S>;

type LastSegment<S extends string> = S extends `${string}.${infer Rest}`
  ? LastSegment<Rest>
  : S;

type BaseVerb =
  | "retry"
  | "start"
  | "complete"
  | "fail"
  | "reject"
  | "skip"
  | "yield"
  | "unlink"
  | "warn";

/** Outcomes that name an action or a direction instead of what happened. */
type ImperativeOutcome =
  | BaseVerb
  | `${string}_${BaseVerb}`
  | "in"
  | "out"
  | "fallback"
  | "wrap_up";

/**
 * `N` when every member of `N` is a valid event name. Otherwise a string
 * literal that says what is wrong, so the `tsc` error explains the fix.
 */
export type LogEventName<N extends string> = N extends string
  ? Record<never, never> extends Record<N, true>
    ? "log event name must be a string literal or a union of literals, not a runtime string"
    : N extends `${string}.${string}`
      ? IsSegmentList<N> extends true
        ? LastSegment<N> extends ImperativeOutcome
          ? `log event name must end in an observed outcome (failed, skipped, retrying), not a base verb or direction: ${N}`
          : N
        : `log event name must be dot-separated segments that start with a-z, use only a-z, 0-9, and _, and do not end in _: ${N}`
      : `log event name must have at least two dot-separated segments: ${N}`
  : never;
