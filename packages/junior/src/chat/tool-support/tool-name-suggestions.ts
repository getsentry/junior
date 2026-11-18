import type { AnyToolDefinition } from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const MAX_SUGGESTIONS = 3;
const MAX_SOURCE_TOOLS = 10;

/**
 * What an unknown tool name error adds: close names, or the tools of the
 * source that the name starts with when none of them is close.
 */
export type ToolNameHint =
  | { suggestions: string[] }
  | { source: string; tools: string[] };

/**
 * A call named a tool that the caller cannot call. `hint` comes from
 * {@link findToolNameHint} and can be empty.
 */
export class ToolNameMissError extends ToolInputError {
  readonly hint: ToolNameHint;

  constructor(message: string, hint: ToolNameHint) {
    const text = renderToolNameHint(hint);
    super(text ? `${message} ${text}` : message);
    this.name = "ToolNameMissError";
    this.hint = hint;
  }
}

/** Number of close names in a hint. A source listing has none. */
export function suggestionCount(hint: ToolNameHint): number {
  return "suggestions" in hint ? hint.suggestions.length : 0;
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[._-]/g, "");
}

/** Lowercase words of a camelCase, snake_case, dotted, or kebab name. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s._-]+/)
    .filter(Boolean);
}

/** True when each wanted word starts a word of `candidate`, in order. */
function hasWordsInOrder(candidate: string[], wanted: string[]): boolean {
  let next = 0;
  for (const word of candidate) {
    if (next < wanted.length && word.startsWith(wanted[next]!)) {
      next += 1;
    }
  }
  return next === wanted.length;
}

/**
 * Hint for a name that starts with a source id, such as `agents.stop`. The
 * model can only mean a tool of that source, so other tools never match.
 */
function sourceHint(
  source: string,
  remainder: string,
  tools: string[],
): ToolNameHint {
  const wanted = normalize(remainder);
  const id = normalize(source);
  // Plugin tools carry the source as a name prefix (`agentBrowser_`).
  const forms = (tool: string) => {
    const full = normalize(tool);
    return full.startsWith(id) ? [full, full.slice(id.length)] : [full];
  };
  const exact = tools.filter((tool) => forms(tool).includes(wanted));
  if (exact.length > 0) {
    return { suggestions: exact.slice(0, MAX_SUGGESTIONS) };
  }
  const wantedWords = words(remainder);
  const byWords = tools
    .map((tool) => ({ tool, words: words(tool) }))
    .filter(
      (candidate) =>
        wantedWords.length > 0 && hasWordsInOrder(candidate.words, wantedWords),
    )
    .sort((left, right) => left.words.length - right.words.length)
    .map(({ tool }) => tool);
  if (byWords.length > 0) {
    return { suggestions: byWords.slice(0, MAX_SUGGESTIONS) };
  }
  // Only this source's tools are candidates, so an edit cannot cross into
  // another source.
  const allowed = editBudget(wanted);
  const byEdits = tools
    .map((tool) => ({
      tool,
      distance: Math.min(
        ...forms(tool).map((form) => editDistance(wanted, form)),
      ),
    }))
    .filter(({ distance }) => distance <= allowed)
    .sort((left, right) => left.distance - right.distance)
    .map(({ tool }) => tool);
  if (byEdits.length > 0) {
    return { suggestions: byEdits.slice(0, MAX_SUGGESTIONS) };
  }
  return { source, tools };
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

/** Most edits a match may need: about a third of the name, at least one. */
function editBudget(name: string): number {
  return Math.max(1, Math.floor(name.length / 3));
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
 * Hint for an unknown tool name. Pass only the tools that the caller can
 * call, so a hidden tool is never named.
 *
 * A name whose first `.` or `_` part is a source id, such as `agents.stop`,
 * matches only tools of that source: an exact match on the rest, then the
 * tools whose words start with its words in order, then the tools within
 * about a third of its length in edits, else a list of the source's tools.
 * Other names match ignoring case, `.`, `_`, `-`, and a source id prefix on
 * either name, then by full names within about a third of the name's
 * length in edits. A match returns up to three names.
 */
export function findToolNameHint(
  name: string,
  tools: Record<string, AnyToolDefinition>,
): ToolNameHint {
  const separator = name.search(/[._]/);
  if (separator > 0) {
    const prefix = normalize(name.slice(0, separator));
    const scoped = Object.keys(tools)
      .filter((tool) => normalize(tools[tool]!.source?.id ?? "") === prefix)
      .sort();
    if (scoped.length > 0) {
      return sourceHint(
        tools[scoped[0]!]!.source!.id,
        name.slice(separator + 1),
        scoped,
      );
    }
  }

  const sourceIds = [
    ...new Set(
      Object.values(tools).flatMap((tool) =>
        tool.source ? [normalize(tool.source.id)] : [],
      ),
    ),
  ].filter((id) => id.length > 0);
  const [wanted, ...wantedWithoutSource] = nameForms(name, sourceIds);
  if (!wanted) {
    return { suggestions: [] };
  }

  const allowed = editBudget(wanted);
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

  return {
    suggestions: ranked
      .sort(
        (left, right) =>
          left.distance - right.distance ||
          (left.candidate < right.candidate ? -1 : 1),
      )
      .slice(0, MAX_SUGGESTIONS)
      .map(({ candidate }) => candidate),
  };
}

/**
 * Render a hint as error text, or "" when it is empty. `prefix` goes before
 * each tool name, such as `tools.` in Code Mode.
 */
export function renderToolNameHint(hint: ToolNameHint, prefix = ""): string {
  if ("source" in hint) {
    const shown = hint.tools
      .slice(0, MAX_SOURCE_TOOLS)
      .map((tool) => `${prefix}${tool}`);
    const more = hint.tools.length - shown.length;
    const rest = more > 0 ? `, and ${more} more` : "";
    return `Tools in \`${hint.source}\`: ${shown.join(", ")}${rest}.`;
  }
  if (hint.suggestions.length === 0) {
    return "";
  }
  const quoted = hint.suggestions.map((name) => `\`${prefix}${name}\``);
  const last = quoted.pop()!;
  const list =
    quoted.length === 0
      ? last
      : `${quoted.join(", ")}${quoted.length > 1 ? "," : ""} or ${last}`;
  return `Did you mean ${list}?`;
}
