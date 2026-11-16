import type { BenchEvent } from "./events";
import { eventText, type CompactionPoint } from "./history";
import { factPresent, normalizeForMatch } from "./recall-score";

/** Identifier kinds that Tier 1 mines without a model. */
export type FactKind = "pr" | "sha" | "uuid" | "path" | "url" | "agent";

/** One identifier that a later Turn used and only removed history held. */
export interface Tier1Fact {
  key: string;
  kind: FactKind;
  value: string;
  point: number;
  firstSeenSeq: number;
  /** Compactions between first sighting and this point. */
  age: number;
  useSeq: number;
  /** The use site with the value masked, for probe questions. */
  maskedUse: string;
}

const PATTERNS: Array<[Exclude<FactKind, "agent">, RegExp]> = [
  ["pr", /(?<![\w/])(?:[\w.-]+\/[\w.-]+)?#(\d{3,6})\b/g],
  [
    "uuid",
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  ],
  ["sha", /\b[0-9a-f]{7,40}\b/g],
  [
    "path",
    /(?:[\w.@-]+\/)+[\w.-]+\.(?:tsx?|mjs|cjs|jsx?|md|mdx|json|ya?ml|sql|css|sh|py|toml)\b/g,
  ],
  ["url", /https?:\/\/[^\s"'<>)\]`]+/g],
];

const AGENT_CALL = /\[tool call: (?:messageAgent|spawnAgent) (\{.*?\})\]/g;

function normalizedValue(kind: FactKind, raw: string): string | undefined {
  if (kind === "pr") return `#${raw.split("#").at(-1)}`;
  if (kind === "sha") {
    // Hex words need both a letter and a digit; skip UUID fragments.
    if (!/[a-f]/.test(raw) || !/\d/.test(raw)) return undefined;
    return raw.slice(0, 7);
  }
  if (kind === "uuid") return raw.toLowerCase();
  if (kind === "path") return raw.split("/").slice(-2).join("/");
  if (kind === "url") return raw.replace(/[.,;:]+$/, "").toLowerCase();
  return raw;
}

/** Extract identifiers from text, keyed by kind and normalized value. */
export function extractFacts(
  text: string,
  agentNames: ReadonlySet<string>,
): Map<
  string,
  { kind: FactKind; value: string; index: number; length: number }
> {
  const found = new Map<
    string,
    { kind: FactKind; value: string; index: number; length: number }
  >();
  const uuidSpans: Array<[number, number]> = [];
  for (const [kind, pattern] of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (kind === "uuid") uuidSpans.push([index, index + match[0].length]);
      if (
        kind === "sha" &&
        uuidSpans.some(([start, end]) => index >= start && index < end)
      ) {
        continue;
      }
      const value = normalizedValue(kind, match[0]);
      if (!value) continue;
      const key = `${kind}:${value}`;
      if (!found.has(key)) {
        found.set(key, { kind, value, index, length: match[0].length });
      }
    }
  }
  for (const match of text.matchAll(AGENT_CALL)) {
    try {
      const args = JSON.parse(match[1]!) as { to?: unknown; name?: unknown };
      for (const name of [args.to, args.name]) {
        if (typeof name === "string" && agentNames.has(name)) {
          const key = `agent:${name}`;
          if (!found.has(key)) {
            found.set(key, {
              kind: "agent",
              value: name,
              index: match.index ?? 0,
              length: match[0].length,
            });
          }
        }
      }
    } catch {
      // Truncated tool arguments carry no usable name.
    }
  }
  return found;
}

const HEX = /\b[0-9a-f]{7,40}\b/g;

/** Kind-aware presence check: a short SHA matches any longer SHA it prefixes. */
export function factIn(
  fact: Pick<Tier1Fact, "kind" | "value">,
  text: string,
  textNorm = normalizeForMatch(text),
): boolean {
  if (fact.kind === "sha") {
    for (const match of textNorm.matchAll(HEX)) {
      if (match[0].startsWith(fact.value)) return true;
    }
    return false;
  }
  if (fact.kind === "agent") {
    return new RegExp(`(?<![\\w-])${escapeRegExp(fact.value)}(?![\\w-])`).test(
      text,
    );
  }
  return factPresent(textNorm, fact.value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskedUse(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 200);
  const end = Math.min(text.length, index + length + 200);
  return `${text.slice(start, index)}▢▢▢${text.slice(index + length, end)}`;
}

/**
 * Mine Tier 1 facts: identifiers that the agent used in the version after a
 * compaction before any message or tool result in that version showed them,
 * and that only the removed history held.
 */
export function mineTier1(
  events: readonly BenchEvent[],
  points: readonly CompactionPoint[],
): Tier1Fact[] {
  const agentNames = new Set<string>();
  for (const event of events) {
    if (
      event.data.type === "subagent_started" &&
      typeof event.data.agentName === "string"
    ) {
      agentNames.add(event.data.agentName);
    }
  }

  const firstSeen = new Map<string, number>();
  const texts = new Map<number, string>();
  for (const event of events) {
    const text = eventText(event.data);
    if (!text) continue;
    texts.set(event.seq, text);
    for (const key of extractFacts(text, agentNames).keys()) {
      if (!firstSeen.has(key)) firstSeen.set(key, event.seq);
    }
  }

  const facts: Tier1Fact[] = [];
  for (const point of points) {
    const removed = [
      point.previousSummary ?? "",
      ...point.dropped.map((message) => message.text),
    ].join("\n");
    const kept = [...point.tail, ...point.after]
      .map((message) => message.text)
      .join("\n");
    const removedNorm = normalizeForMatch(removed);
    const keptNorm = normalizeForMatch(kept);
    const fresh = new Set<string>();
    const used = new Set<string>();

    for (const event of events) {
      if (event.seq <= point.seq) continue;
      if (event.seq > point.windowEndSeq) break;
      const text = texts.get(event.seq);
      if (!text) continue;
      const found = extractFacts(text, agentNames);
      if (event.data.type !== "assistant_message") {
        for (const key of found.keys()) fresh.add(key);
        continue;
      }
      for (const [key, fact] of found) {
        if (fresh.has(key) || used.has(key)) continue;
        used.add(key);
        if (!factIn(fact, removed, removedNorm)) continue;
        if (factIn(fact, kept, keptNorm)) continue;
        const seen = firstSeen.get(key) ?? event.seq;
        facts.push({
          key,
          kind: fact.kind,
          value: fact.value,
          point: point.index,
          firstSeenSeq: seen,
          age: points.filter((p) => p.seq > seen && p.seq <= point.seq).length,
          useSeq: event.seq,
          maskedUse:
            fact.kind === "agent"
              ? text
                  .slice(fact.index, fact.index + 400)
                  .replaceAll(fact.value, "▢▢▢")
              : maskedUse(text, fact.index, fact.length),
        });
      }
    }
  }
  return facts;
}
