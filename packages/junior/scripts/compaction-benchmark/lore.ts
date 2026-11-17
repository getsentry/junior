// Copyright (c) Burak Yigit Kaya. Adapted from Lore (BYK/loreai) at the
// author's request: the curator prompt and op parsing (packages/core/src
// prompt.ts, curator.ts), entry selection, packing and the pinned preference
// block (ltm.ts, prompt.ts formatKnowledge), and separate per-layer token
// budgets (gradient.ts). Relevance here is BM25 only; Lore also uses
// embeddings, so these arms are a lower bound for Lore.
import { estimateTextTokens } from "@/chat/services/token-estimate";
import type { ArmContext } from "./arms";
import type { CompactionPoint } from "./history";
import { MODELS, type ModelCall } from "./models";
import { callsBetween, type BenchTurn } from "./turns";
import {
  CONSOLIDATION_SYSTEM,
  consolidationUser,
  parseObservations,
  SECTIONED_CONSOLIDATION_SYSTEM,
} from "./prompt";

type Call = (request: ModelCall) => Promise<{ text: string; costUsd: number }>;

export type Category =
  | "constraint"
  | "decision"
  | "pattern"
  | "preference"
  | "architecture"
  | "gotcha"
  | "open_ask"
  | "reference";

const CATEGORIES = new Set<string>([
  "constraint",
  "decision",
  "pattern",
  "preference",
  "architecture",
  "gotcha",
  "open_ask",
  "reference",
]);

/** Lore pins these categories in every request instead of ranking them. */
const PINNED = new Set<string>(["constraint", "preference"]);

/** One curated knowledge entry. */
export interface KnowledgeEntry {
  id: string;
  category: Category;
  title: string;
  content: string;
  confidence: number;
  /** Compaction point index of the last change. */
  updatedAt: number;
}

/** A searchable unit: a knowledge entry or one observation line. */
export interface LoreDoc {
  id: string;
  category: string;
  title: string;
  content: string;
}

/** Lore state after one compaction point. */
export interface LorePoolPoint {
  point: number;
  entries: KnowledgeEntry[];
  observations: LoreDoc[];
  meta: string;
  curatorUsd: number;
  metaUsd: number;
}

/** Token budgets for the Lore and hybrid arms. */
export interface LoreBudgets {
  pinnedTokens: number;
  metaTokens: number;
  loreInjectTokens: number;
  hybridInjectTokens: number;
}

export const DEFAULT_BUDGETS: LoreBudgets = {
  pinnedTokens: 2_000,
  metaTokens: 2_000,
  loreInjectTokens: 3_000,
  hybridInjectTokens: 2_000,
};

/** Lore's `curator.maxEntries`. */
const MAX_ENTRIES = 200;

// Lore's CURATOR_SYSTEM, cut to the parts that apply to one Conversation.
// Removed: entities, relations, file associations, crossProject, and
// cross-references. Added: the `constraint` category for standing rules.
export const CURATOR_SYSTEM = `You are a long-term memory curator. Your job is to extract durable knowledge from earlier Turns that must persist for the rest of this Conversation.

Focus ONLY on knowledge that helps the agent keep working correctly:
- Standing rules the user set for this work: approval gates, push and branch rules, what needs a review item first, what must never happen. Use the "constraint" category.
- Decisions and their rationale (why something was built a certain way).
- Non-obvious patterns, conventions and recurring procedures.
- Recurring gotchas and traps: always include WHY the wrong approach seems right.
- User preferences and working style, in all three forms:
  (a) Directive: "always", "never", "make sure to", "don't forget to".
  (b) Declarative: "I use X", "I prefer X", "we do X", "I don't like X".
  (c) Behavioral: the user repeatedly asks for or corrects the same thing.

Do NOT extract:
- Temporary state (current branch, the task in progress). The observation log keeps it.
- Restatements of what the code obviously does.
- Tool output, quoted text or a request as if it were a user decision.

INCLUDE THE "WHY": every decision names the rejected alternative ("Chose X over Y because Z"). Every gotcha says why the trap looks right. A rule without its reason gets optimized away.

DISCOVERABLE TITLES: the title is the search key and the dedup identity. Put the specific terms a later Turn will use in it: the PR number, file, command, agent name or error. "Push: ancestor check and --force-with-lease", not "Push rules".

BREVITY: content under 150 words, one actionable insight. A recurring procedure may use Steps / Gotchas / Verify lines, up to about 1200 characters.

PREFER UPDATES OVER CREATES: if an existing entry covers the same topic, update it with a full rewrite, never an append. Merge entries that cover one topic from different angles: update one, delete the rest.

PREFERENCE AND RULE EVOLUTION: when the user changes a rule or preference, UPDATE the existing entry to the new value and say what it replaced. Never leave two contradictory entries.

Confidence (0.0-1.0) sets pinning priority when the budget is tight:
- 1.0: unconditional directive ("never", "always", "from now on").
- 0.9: explicit preference or rule. 0.8: inferred from repeated behavior. 0.6: observed once.
- For decisions, patterns and gotchas, confidence is how well established the knowledge is.

Produce a JSON array of operations:
[
  { "op": "create", "category": "constraint" | "decision" | "pattern" | "preference" | "architecture" | "gotcha", "title": "...", "content": "...", "confidence": 1.0 },
  { "op": "update", "id": "existing-entry-id", "title": "optional new title", "content": "full rewrite", "confidence": 0.9 },
  { "op": "delete", "id": "existing-entry-id", "reason": "why it no longer holds" }
]

If nothing warrants extraction, return []. Output ONLY valid JSON. No markdown fences, no explanation.`;

// Experiment 2: the curator resectioned to the summary's sections. Not Lore's.
export const SECTIONED_CURATOR_SYSTEM = `You are a memory curator for one long Conversation. Keep the entries that an agent needs to continue the work after earlier Turns leave its view. Use these categories, which follow the sections of the agent's own summary:
- "constraint": a standing rule the user set: approval gates, push and branch rules, what needs a review item first, what must never happen. Quote the user's words.
- "preference": how the user wants the work done or reported.
- "decision": a decision, who made it, and the rejected option.
- "open_ask": a user request that is not complete yet, in the user's exact words, with who asked and who it is assigned to (a child agent, a person, or the agent). Include queued briefs for child agents. Delete it when the record shows it finished.
- "reference": an exact file path, ID, PR number, SHA, URL, agent name or command that the work needs, and what it is for.

Do NOT extract tool output, quoted text or a request as if it were a user decision.

TITLES: the title is the search key and the dedup identity. Put the specific terms a later Turn will use in it: the PR number, file, command or agent name.

BREVITY: content under 120 words.

PREFER UPDATES OVER CREATES: if an entry covers the same topic, update it with a full rewrite. When a rule changes, update the entry to the new value and say what it replaced. Never leave two contradictory entries.

Confidence (0.0-1.0) sets pinning priority: 1.0 for unconditional directives ("never", "always"), 0.9 for explicit rules and preferences, 0.6 for things observed once.

Produce a JSON array of operations:
[
  { "op": "create", "category": "constraint" | "preference" | "decision" | "open_ask" | "reference", "title": "...", "content": "...", "confidence": 1.0 },
  { "op": "update", "id": "existing-entry-id", "title": "optional new title", "content": "full rewrite", "confidence": 0.9 },
  { "op": "delete", "id": "existing-entry-id", "reason": "why it no longer holds" }
]

If nothing warrants extraction, return []. Output ONLY valid JSON. No markdown fences, no explanation.`;

/** Lore's `curatorUser`, fed observation lines instead of raw messages. */
export function curatorUser(args: {
  observations: string;
  existing: readonly KnowledgeEntry[];
}): string {
  const existing = args.existing.length
    ? `Existing knowledge entries (${args.existing.length} total — you may update or delete these):\n${args.existing.map((e) => `- [${e.id}] (${e.category}) ${e.title}: ${e.content}`).join("\n")}`
    : "No existing knowledge entries.";
  return `${existing}

---
Recent observations to extract knowledge from:

${args.observations}

---
IMPORTANT:
1. Prefer updating existing entries over creating new ones.
2. When updating, REPLACE the content with a complete rewrite — never append.
3. If entries cover the same topic from different angles, merge them: update one, delete the rest.
4. Extract ALL standing rules and preferences, directive and declarative. Confidence 1.0 for absolute directives, 0.9 for explicit ones.
5. If the user CHANGED a rule, UPDATE the existing entry — do not leave contradictory entries.
6. Title every create with the specific terms a later Turn will search.`;
}

interface CuratorOp {
  op: "create" | "update" | "delete";
  id?: string;
  category?: string;
  title?: string;
  content?: string;
  confidence?: number;
}

/** Lore's forgiving op parser: bare array or `{ops}`, fences allowed. */
export function parseOps(text: string): CuratorOp[] {
  const cleaned = text
    .trim()
    .replace(/^```json?\s*/i, "")
    .replace(/\s*```$/i, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { ops?: unknown })?.ops)
      ? (parsed as { ops: unknown[] }).ops
      : [];
  return list.filter((value): value is CuratorOp => {
    const op = value as CuratorOp;
    if (op?.op === "create") {
      return (
        typeof op.title === "string" &&
        typeof op.content === "string" &&
        CATEGORIES.has(String(op.category))
      );
    }
    return (op?.op === "update" || op?.op === "delete") && !!op.id;
  });
}

/**
 * Apply curator ops, then evict the lowest-value entries past the cap, as
 * Lore's `enforceEntryCap` does. Value here is confidence, then recency.
 */
export function applyOps(
  entries: readonly KnowledgeEntry[],
  ops: readonly CuratorOp[],
  point: number,
): KnowledgeEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, { ...entry }]));
  let next = entries.reduce(
    (max, entry) => Math.max(max, Number(entry.id.slice(1)) || 0),
    0,
  );
  for (const op of ops) {
    if (op.op === "create") {
      next += 1;
      const id = `k${next}`;
      byId.set(id, {
        id,
        category: op.category as Category,
        title: op.title!,
        content: op.content!,
        confidence: clamp(op.confidence ?? 1),
        updatedAt: point,
      });
    } else if (op.op === "update") {
      const entry = byId.get(op.id!);
      if (!entry) continue;
      if (op.title) entry.title = op.title;
      if (op.content) entry.content = op.content;
      if (typeof op.confidence === "number") {
        entry.confidence = clamp(op.confidence);
      }
      entry.updatedAt = point;
    } else {
      byId.delete(op.id!);
    }
  }
  return [...byId.values()]
    .sort(byPinPriority)
    .slice(0, MAX_ENTRIES)
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// Lore's preference order: confidence, then recency, then id.
function byPinPriority(a: KnowledgeEntry, b: KnowledgeEntry): number {
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id < b.id ? -1 : 1;
}

/** Lore's `KNOWLEDGE_HEADER_OVERHEAD_TOKENS`. */
const HEADER_TOKENS = 50;

/** Lore's `knowledgeEntryTokenCost`, without the id prefix. */
function docTokens(doc: LoreDoc): number {
  return estimateTextTokens(doc.title + doc.content) + 10;
}

/** Lore's packing: take docs in rank order, skip any that do not fit. */
function pack<T extends LoreDoc>(docs: readonly T[], budget: number): T[] {
  let used = HEADER_TOKENS;
  const kept: T[] = [];
  for (const doc of docs) {
    const cost = docTokens(doc);
    if (used + cost > budget) continue;
    kept.push(doc);
    used += cost;
  }
  return kept;
}

/**
 * Lore's `formatKnowledge` layout: the rank decides selection; output order
 * is fixed by category, then title, so the block is byte-stable.
 */
function formatDocs(heading: string, docs: readonly LoreDoc[]): string {
  if (!docs.length) return "";
  const groups = new Map<string, LoreDoc[]>();
  for (const doc of docs) {
    groups.set(doc.category, [...(groups.get(doc.category) ?? []), doc]);
  }
  const lines = [`## ${heading}`];
  for (const category of [...groups.keys()].sort()) {
    lines.push(`### ${category[0]!.toUpperCase()}${category.slice(1)}`);
    for (const doc of groups
      .get(category)!
      .sort((a, b) => (a.title + a.content < b.title + b.content ? -1 : 1))) {
      lines.push(
        doc.title ? `- **${doc.title}**: ${doc.content}` : `- ${doc.content}`,
      );
    }
  }
  return lines.join("\n");
}

/** The always-injected block: constraints and preferences by priority. */
export function pinnedBlock(
  entries: readonly KnowledgeEntry[],
  budget: number,
): string {
  const pinned = entries.filter((entry) => PINNED.has(entry.category));
  return formatDocs(
    "Pinned knowledge",
    pack([...pinned].sort(byPinPriority), budget),
  );
}

/** Docs that compete for per-Turn injection: everything not pinned. */
export function injectionDocs(pool: LorePoolPoint): LoreDoc[] {
  return [
    ...pool.entries.filter((entry) => !PINNED.has(entry.category)),
    ...pool.observations,
  ];
}

// Lore's default BM25 column weights (config `search.ftsWeights`).
const WEIGHTS = { title: 6, content: 2, category: 3 };
const K1 = 1.2;
const B = 0.75;

function terms(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_#./@-]{2,}/g) ?? [];
}

/** BM25F over title, content and category with Lore's column weights. */
export function bm25(
  docs: readonly LoreDoc[],
  query: string,
): Array<{ doc: LoreDoc; score: number }> {
  const queryTerms = [...new Set(terms(query))];
  if (!queryTerms.length || !docs.length) return [];
  const fields = docs.map((doc) => ({
    doc,
    title: terms(doc.title),
    content: terms(doc.content),
    category: terms(doc.category),
  }));
  const length = (row: (typeof fields)[number]) =>
    WEIGHTS.title * row.title.length +
    WEIGHTS.content * row.content.length +
    WEIGHTS.category * row.category.length;
  const averageLength =
    fields.reduce((sum, row) => sum + length(row), 0) / fields.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const row of fields) {
    const seen = new Set([...row.title, ...row.content, ...row.category]);
    for (const term of queryTerms) {
      if (seen.has(term)) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }
  return fields
    .map((row) => {
      const norm = K1 * (1 - B + (B * length(row)) / averageLength);
      let score = 0;
      for (const term of queryTerms) {
        const frequency = documentFrequency.get(term) ?? 0;
        if (!frequency) continue;
        const count = (list: string[]) =>
          list.filter((value) => value === term).length;
        const weighted =
          WEIGHTS.title * count(row.title) +
          WEIGHTS.content * count(row.content) +
          WEIGHTS.category * count(row.category);
        if (!weighted) continue;
        const idf = Math.log(
          1 + (docs.length - frequency + 0.5) / (frequency + 0.5),
        );
        score += (idf * weighted * (K1 + 1)) / (weighted + norm);
      }
      return { doc: row.doc, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || (a.doc.id < b.doc.id ? -1 : 1));
}

/** Top entries and observations for one Turn input, packed under a budget. */
export function injectBlock(
  docs: readonly LoreDoc[],
  query: string,
  budget: number,
): string {
  const kept = pack(
    bm25(docs, query).map((row) => row.doc),
    budget,
  );
  return formatDocs("Recalled for this Turn", kept);
}

function trimToTokens(text: string, budget: number): string {
  const lines = text.split("\n");
  while (lines.length > 1 && estimateTextTokens(lines.join("\n")) > budget) {
    lines.pop();
  }
  return lines.join("\n");
}

function observationDocs(point: number, text: string): LoreDoc[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line.length > 3)
    .map((line, index) => ({
      id: `o${point}-${index}`,
      category: "observation",
      title: "",
      content: line,
    }));
}

/**
 * Curate each compaction point's new observations into knowledge entries,
 * and keep an anchored meta working context under its own budget.
 */
export async function buildLorePool(args: {
  points: readonly CompactionPoint[];
  /** New observation blocks per point, from the distillation chain. */
  observations: ReadonlyMap<number, readonly string[]>;
  budgets: LoreBudgets;
  call: Call;
  /** `sectioned`: the summary-sectioned curator and meta prompts (experiment 2). */
  variant?: "sectioned";
  /** Pool state to continue from, such as an earlier point's pool. */
  initial?: LorePoolPoint;
}): Promise<LorePoolPoint[]> {
  const suffix = args.variant ? `-${args.variant}` : "";
  let entries: KnowledgeEntry[] = [...(args.initial?.entries ?? [])];
  let meta: string | undefined = args.initial?.meta || undefined;
  const observations: LoreDoc[] = [...(args.initial?.observations ?? [])];
  const pool: LorePoolPoint[] = [];
  for (const point of args.points) {
    const fresh = args.observations.get(point.index) ?? [];
    let curatorUsd = 0;
    let metaUsd = 0;
    if (fresh.length) {
      const curated = await args.call({
        stage: `lore-curator${suffix}`,
        modelId: MODELS.luna,
        system: args.variant ? SECTIONED_CURATOR_SYSTEM : CURATOR_SYSTEM,
        user: curatorUser({
          observations: fresh.join("\n\n"),
          existing: entries,
        }),
        maxTokens: 8_000,
        expectedOutputTokens: 2_500,
      });
      curatorUsd = curated.costUsd;
      entries = applyOps(entries, parseOps(curated.text), point.index);
      const updated = await args.call({
        stage: `lore-meta${suffix}`,
        modelId: MODELS.luna,
        system: args.variant
          ? SECTIONED_CONSOLIDATION_SYSTEM
          : CONSOLIDATION_SYSTEM,
        user: `${consolidationUser({ segments: fresh, previousMeta: meta })}\n\nKeep the whole block under about ${args.budgets.metaTokens} tokens. Compress the oldest timeline detail first.`,
        maxTokens: args.budgets.metaTokens * 2,
        expectedOutputTokens: args.budgets.metaTokens,
      });
      metaUsd = updated.costUsd;
      const parsed = parseObservations(updated.text);
      if (parsed) meta = trimToTokens(parsed, args.budgets.metaTokens);
      fresh.forEach((block, index) =>
        observations.push(
          ...observationDocs(point.index, block).map((doc) => ({
            ...doc,
            id: `${doc.id}-${index}`,
          })),
        ),
      );
    }
    pool.push({
      point: point.index,
      entries,
      observations: [...observations],
      meta: meta ?? "",
      curatorUsd,
      metaUsd,
    });
  }
  return pool;
}

/** An arm's context for one Turn: the fixed block plus per-Turn retrieval. */
export function composeContext(entry: ArmContext, query: string): string {
  if (!entry.injection) return entry.context;
  const block = injectBlock(
    entry.injection.docs,
    query,
    entry.injection.budget,
  );
  return [entry.context, block].filter(Boolean).join("\n\n");
}

/**
 * Build the `lore` and `hybrid` arms from the curated pool. `lore` keeps
 * the pinned block and the meta working context; `hybrid` keeps today's
 * summary and the pinned block. Both add per-Turn retrieval, priced on the
 * real Turns and agent calls of the next version.
 */
export function loreArms(args: {
  points: readonly CompactionPoint[];
  pool: readonly LorePoolPoint[];
  turns: readonly BenchTurn[];
  recorded: readonly ArmContext[];
  distillUsd: ReadonlyMap<number, number>;
  budgets: LoreBudgets;
  /** Dry runs fill the fixed blocks to their budgets, for pricing. */
  dryRun: boolean;
}): Record<"lore" | "hybrid", ArmContext[]> {
  const build = (name: "lore" | "hybrid") =>
    args.pool.map((pool): ArmContext => {
      const point = args.points[pool.point]!;
      const pinned = args.dryRun
        ? "x ".repeat(args.budgets.pinnedTokens)
        : pinnedBlock(pool.entries, args.budgets.pinnedTokens);
      const meta = args.dryRun
        ? "x ".repeat(args.budgets.metaTokens)
        : pool.meta;
      const recorded = args.recorded[pool.point]!;
      const context = (
        name === "lore"
          ? [pinned, meta && `## Working context\n${meta}`]
          : [recorded.context, pinned]
      )
        .filter(Boolean)
        .join("\n\n");
      const budget =
        name === "lore"
          ? args.budgets.loreInjectTokens
          : args.budgets.hybridInjectTokens;
      const docs = injectionDocs(pool);
      const turns = callsBetween(args.turns, point.seq, point.windowEndSeq).map(
        ({ turn, calls }) => ({
          calls,
          tokens: args.dryRun
            ? budget
            : estimateTextTokens(injectBlock(docs, turn.input, budget)),
        }),
      );
      const distillUsd = args.distillUsd.get(pool.point) ?? 0;
      return {
        point: pool.point,
        context,
        tokens: estimateTextTokens(context),
        workerCostUsd:
          name === "lore"
            ? distillUsd + pool.curatorUsd + pool.metaUsd
            : recorded.workerCostUsd + distillUsd + pool.curatorUsd,
        injection: { budget, docs, turns },
      };
    });
  return { lore: build("lore"), hybrid: build("hybrid") };
}
