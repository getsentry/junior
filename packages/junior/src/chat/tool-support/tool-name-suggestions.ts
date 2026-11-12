import type { AnyToolDefinition } from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const MAX_SUGGESTIONS = 3;

/**
 * A call named a tool that the caller cannot call. `suggestions` are the
 * close names from {@link suggestToolNames}, possibly none.
 */
export class ToolNameMissError extends ToolInputError {
  readonly suggestions: readonly string[];

  constructor(message: string, suggestions: readonly string[]) {
    super(
      suggestions.length > 0
        ? `${message} ${didYouMean(suggestions)}`
        : message,
    );
    this.name = "ToolNameMissError";
    this.suggestions = suggestions;
  }
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[._-]/g, "");
}

/** The normalized name, then the name after each source id it starts with. */
function nameForms(name: string, sourceIds: readonly string[]): string[] {
  const base = normalize(name);
  return [
    base,
    ...sourceIds
      .filter((id) => base.length > id.length && base.startsWith(id))
      .map((id) => base.slice(id.length)),
  ];
}

/** Edit distance where swapping two neighbors costs one edit. */
function editDistance(a: string, b: string): number {
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j]!, before[j - 2]! + 1);
      }
    }
    [before, previous] = [previous, current];
  }
  return previous[b.length]!;
}

/**
 * Return up to three names from `tools` that are close to `name`, closest
 * first. The match ignores case, `.`, `_`, `-`, and a source id prefix on
 * either name, so `agents.stopAgent` finds `stopAgent`. Otherwise the
 * full names must be within about a third of the name's length in edits.
 * Pass only the tools that the caller can call, so a hidden tool is never
 * named.
 */
export function suggestToolNames(
  name: string,
  tools: Record<string, AnyToolDefinition>,
): string[] {
  const sourceIds = [
    ...new Set(
      Object.values(tools).flatMap((tool) =>
        tool.source ? [normalize(tool.source.id)] : [],
      ),
    ),
  ].filter((id) => id.length > 0);
  const [wanted, ...wantedWithoutSource] = nameForms(name, sourceIds);
  if (!wanted) {
    return [];
  }

  const allowed = Math.max(1, Math.floor(wanted.length / 3));
  const ranked = Object.keys(tools).flatMap((candidate) => {
    const [full, ...withoutSource] = nameForms(candidate, sourceIds);
    // A source id stripped from one side must leave an exact match. With
    // edits on top, deleting a short prefix fits the edit budget, so
    // `slack_createCanvas` would find `github_createCanvas`.
    const exact =
      wantedWithoutSource.includes(full!) || withoutSource.includes(wanted);
    const distance = exact ? 0 : editDistance(wanted, full!);
    return distance <= allowed ? [{ candidate, distance }] : [];
  });

  return ranked
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        (left.candidate < right.candidate ? -1 : 1),
    )
    .slice(0, MAX_SUGGESTIONS)
    .map(({ candidate }) => candidate);
}

/** Render `Did you mean `a`, `b`, or `c`?` for one or more suggestions. */
export function didYouMean(suggestions: readonly string[]): string {
  const quoted = suggestions.map((suggestion) => `\`${suggestion}\``);
  const last = quoted.pop()!;
  const list =
    quoted.length === 0
      ? last
      : `${quoted.join(", ")}${quoted.length > 1 ? "," : ""} or ${last}`;
  return `Did you mean ${list}?`;
}
