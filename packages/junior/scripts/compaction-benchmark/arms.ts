import { SUMMARY_INSTRUCTION } from "@/chat/agent/context-summary";
import { estimateTextTokens } from "@/chat/services/token-estimate";
import { renderMessages, segments, type CompactionPoint } from "./history";
import type { LoreDoc } from "./lore";
import { MODELS, mapLimit, type ModelCall } from "./models";
import {
  CONSOLIDATION_SYSTEM,
  DISTILLATION_SYSTEM,
  consolidationUser,
  distillationUser,
  parseObservations,
} from "./prompt";

/** What one arm puts in model view in place of removed history. */
export interface ArmContext {
  point: number;
  context: string;
  tokens: number;
  /** Model spend this arm needed at this point. */
  workerCostUsd: number;
  /** Observation blocks this point added, for the Lore curator. */
  observations?: string[];
  /** Per-Turn retrieval on top of `context`, for the Lore and hybrid arms. */
  injection?: Injection;
}

/** Docs one arm retrieves from for each Turn, and what that cost per Turn. */
export interface Injection {
  budget: number;
  docs: LoreDoc[];
  /** Real Turns of the next version: agent calls and injected tokens. */
  turns: Array<{ calls: number; tokens: number }>;
}

type Call = (request: ModelCall) => Promise<{ text: string; costUsd: number }>;

/** Free arms built from the log alone. */
export function freeArms(points: readonly CompactionPoint[]) {
  const arm = (context: (point: CompactionPoint) => string, cost = false) =>
    points.map((point) => {
      const text = context(point);
      return {
        point: point.index,
        context: text,
        tokens: estimateTextTokens(text),
        workerCostUsd: cost ? (point.recordedSummaryCostUsd ?? 0) : 0,
      };
    });
  return {
    empty: arm(() => ""),
    recorded: arm((point) => point.recordedSummary, true),
    // Upper bound: everything this compaction removed.
    removed: arm((point) =>
      [point.previousSummary ?? "", renderMessages(point.dropped)].join("\n\n"),
    ),
  };
}

/**
 * Rerun today's summary prompt on rebuilt history. Production reuses the
 * cached agent request; this sends the rendered history as text, so it
 * measures summary variance, not production cost.
 */
export async function summaryRerun(
  points: readonly CompactionPoint[],
  call: Call,
  run: number,
): Promise<ArmContext[]> {
  return mapLimit(points, 2, async (point) => {
    const history = [
      point.previousSummary ? `Earlier summary:\n${point.previousSummary}` : "",
      // Today's summary saw history only up to its request mark.
      renderMessages(
        [...point.dropped, ...point.tail].filter(
          (message) => message.seq <= point.markSeq,
        ),
      ),
    ].join("\n\n");
    const result = await call({
      stage: `summary-rerun-${run}`,
      modelId: MODELS.opus,
      system: "You are Junior. Summarize the conversation history below.",
      user: `<history run="${run}">\n${history}\n</history>\n\n${SUMMARY_INSTRUCTION}`,
      maxTokens: 8_000,
      expectedOutputTokens: 2_000,
    });
    const summary =
      /<summary>([\s\S]*?)<\/summary>/.exec(result.text)?.[1]?.trim() ??
      result.text;
    return {
      point: point.index,
      context: summary,
      tokens: estimateTextTokens(summary),
      workerCostUsd: result.costUsd,
    };
  });
}

const CONSOLIDATE_AFTER = 20;
const KEEP_RECENT = 10;

/**
 * Lore-style chain: one observation per removed segment, appended across
 * compactions. Past 20 observations, the oldest merge into one meta summary.
 */
export async function distillationChain(
  points: readonly CompactionPoint[],
  modelId: string,
  call: Call,
): Promise<ArmContext[]> {
  const stage = `distill-${modelId.split("/").at(-1)}`;
  let observations: string[] = [];
  let meta: string | undefined;
  const contexts: ArmContext[] = [];
  for (const point of points) {
    let cost = 0;
    const added: string[] = [];
    const date = point.createdAt.slice(0, 10);
    for (const segment of segments(point.dropped)) {
      const result = await call({
        stage,
        modelId,
        system: DISTILLATION_SYSTEM,
        user: distillationUser({
          date,
          messages: renderMessages(segment),
          priorObservations: observations.slice(-3).join("\n") || undefined,
        }),
        maxTokens: 2_048,
        expectedOutputTokens: 1_200,
      });
      cost += result.costUsd;
      const parsed = parseObservations(result.text) ?? result.text.trim();
      if (parsed) {
        observations.push(parsed);
        added.push(parsed);
      }
    }
    if (observations.length > CONSOLIDATE_AFTER) {
      const older = observations.slice(0, -KEEP_RECENT);
      const result = await call({
        stage: `${stage}-consolidate`,
        modelId,
        system: CONSOLIDATION_SYSTEM,
        user: consolidationUser({ segments: older, previousMeta: meta }),
        maxTokens: 8_000,
        expectedOutputTokens: 4_000,
      });
      cost += result.costUsd;
      meta = parseObservations(result.text) ?? result.text.trim();
      observations = observations.slice(-KEEP_RECENT);
    }
    const context = [
      meta ? `<meta-summary>\n${meta}\n</meta-summary>` : "",
      ...observations,
    ]
      .filter(Boolean)
      .join("\n\n");
    contexts.push({
      point: point.index,
      context,
      tokens: estimateTextTokens(context),
      workerCostUsd: cost,
      observations: added,
    });
  }
  return contexts;
}

/** A model-mined probe for BYK to check before scoring. */
export interface Tier2Item {
  id: string;
  point: number;
  kind: "open_ask" | "assignment" | "decision" | "constraint" | "queued_brief";
  question: string;
  expectedFacts: string[];
  forbiddenFacts: string[];
  sourceSeqs: number[];
  usedAtSeqs: number[];
}

const TIER2_SYSTEM = `You build ground truth for a context-retention benchmark. You read history that a compaction removed and the work that came after it.

List only items that the later work actually needed: open asks, assignments to child agents, queued briefs, decisions, and standing constraints. Skip items that the later work restated before using them.

For each item give: kind (open_ask, assignment, decision, constraint, queued_brief), a question that a continuing agent must answer from memory, 1-3 short exact expectedFacts (names, IDs, values) that a correct answer contains, forbiddenFacts for values that the history superseded, sourceSeqs (where the removed history states it) and usedAtSeqs (where later work needed it).

Output ONLY a JSON array.`;

/** Mine Tier 2 probes at one compaction point. */
export async function mineTier2(
  points: readonly CompactionPoint[],
  windows: ReadonlyMap<number, string>,
  call: Call,
): Promise<Tier2Item[]> {
  const perPoint = await mapLimit(points, 3, async (point) => {
    const removed = point.dropped.filter(
      (message) =>
        message.role === "user" ||
        (message.role === "assistant" &&
          /messageAgent|spawnAgent|addReviewItem/.test(message.text)),
    );
    const result = await call({
      stage: "tier2-mine",
      modelId: MODELS.opus,
      system: TIER2_SYSTEM,
      user: `<removed-history>\n${point.previousSummary ? `Earlier summary:\n${point.previousSummary}\n\n` : ""}${renderMessages(removed)}\n</removed-history>\n\n<later-work>\n${windows.get(point.index) ?? ""}\n</later-work>`,
      maxTokens: 8_000,
      expectedOutputTokens: 3_000,
    });
    const json = /\[[\s\S]*\]/.exec(result.text)?.[0];
    const items = json
      ? (JSON.parse(json) as Omit<Tier2Item, "id" | "point">[])
      : [];
    return items.map((item, index) => ({
      ...item,
      id: `p${point.index}-${index}`,
      point: point.index,
    }));
  });
  return perPoint.flat();
}

/** Keyword retrieval over removed history, standing in for the raw tier. */
export function rawSearch(
  point: CompactionPoint,
  query: string,
  limit = 5,
): string {
  const terms = [
    ...new Set(query.toLowerCase().match(/[a-z0-9_./#-]{4,}/g) ?? []),
  ];
  return point.dropped
    .map((message) => {
      const lower = message.text.toLowerCase();
      return {
        message,
        score: terms.reduce(
          (sum, term) => sum + (lower.includes(term) ? 1 : 0),
          0,
        ),
      };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ message }) => `seq ${message.seq}: ${message.text.slice(0, 3_000)}`)
    .join("\n\n");
}

/** Ask the probe model one question from an arm's context. */
export async function answerProbe(args: {
  arm: string;
  point: CompactionPoint;
  context: string;
  question: string;
  withRaw: boolean;
  call: Call;
}): Promise<{ answer: string; costUsd: number }> {
  const raw = args.withRaw ? rawSearch(args.point, args.question) : "";
  const result = await args.call({
    stage: `probe-${args.arm}${args.withRaw ? "-raw" : ""}`,
    modelId: MODELS.luna,
    system:
      "You continue earlier work. Answer from the supplied context only. Reply with the answer value only, or 'unknown'.",
    user: `<context>\n${args.context}\n</context>\n${raw ? `<search-results>\n${raw}\n</search-results>\n` : ""}\n${args.question}`,
    maxTokens: 300,
    expectedOutputTokens: 40,
  });
  return { answer: result.text, costUsd: result.costUsd };
}
