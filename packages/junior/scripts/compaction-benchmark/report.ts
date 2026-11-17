import { estimateTextTokens } from "@/chat/services/token-estimate";
import type { ArmContext, Tier2Item } from "./arms";
import type { CompactionPoint } from "./history";
import { MODELS, rates } from "./models";
import { composeContext } from "./lore";
import { normalizeForMatch, scoreRetrieval } from "./recall-score";
import { factIn, type Tier1Fact } from "./tier1";

/** One scored probe answer. */
export interface ProbeResult {
  arm: string;
  withRaw: boolean;
  tier: 1 | 2;
  id: string;
  point: number;
  age: number;
  recall: number;
  leaked: number;
  costUsd: number;
}

function ageBucket(age: number): string {
  return age <= 1 ? "1" : age <= 4 ? "2-4" : "5+";
}

function mean(values: readonly number[]): number | undefined {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;
}

/** Tier 1 recall by plain presence in each arm's context. No model. */
export function tier1Presence(
  facts: readonly Tier1Fact[],
  arm: readonly ArmContext[],
  queryFor: (fact: Tier1Fact) => string,
) {
  const scored = facts.filter((fact) =>
    arm.some((entry) => entry.point === fact.point),
  );
  const hits = scored.map((fact) => {
    const entry = arm.find((context) => context.point === fact.point)!;
    const text = composeContext(entry, queryFor(fact));
    return { fact, hit: factIn(fact, text, normalizeForMatch(text)) };
  });
  const recall = (rows: typeof hits) =>
    mean(rows.map((row) => (row.hit ? 1 : 0)));
  const group = (key: (fact: Tier1Fact) => string) => {
    const result: Record<string, { n: number; recall: number | undefined }> =
      {};
    for (const value of new Set(scored.map(key))) {
      const rows = hits.filter((row) => key(row.fact) === value);
      result[value] = { n: rows.length, recall: recall(rows) };
    }
    return result;
  };
  return {
    n: scored.length,
    recall: recall(hits),
    byKind: group((fact) => fact.kind),
    byAge: group((fact) => ageBucket(fact.age)),
    misses: hits.filter((row) => !row.hit).map((row) => row.fact.key),
  };
}

/** Score a Tier 1 probe answer. */
export function scoreTier1Answer(fact: Tier1Fact, answer: string): number {
  return factIn(fact, answer) ? 1 : 0;
}

/** Score a Tier 2 probe answer, counting leaked stale facts. */
export function scoreTier2Answer(item: Tier2Item, answer: string) {
  const score = scoreRetrieval(answer, item);
  return {
    recall: score?.factRecall ?? 0,
    leaked: score?.leakedStaleFacts.length ?? 0,
  };
}

/**
 * Model the next version's Opus prompt cost per #2029's accounting: one cold
 * write of the replacement, then cached reads for each later call, plus the
 * arm's own worker spend. Growth after the replacement is the same in every
 * arm, so only the replacement size differs. A pinned block is part of the
 * replacement, so it is a cached prefix. Per-Turn retrieval is a cold write
 * once per real Turn, then a cached read for that Turn's later calls. This
 * assumes it rides in the Turn input, after the cached history.
 */
export function versionCost(point: CompactionPoint, arm: ArmContext): number {
  const replacement =
    point.details.replacementInputTokens -
    estimateTextTokens(point.recordedSummary) +
    arm.tokens;
  const rate = rates(MODELS.opus, replacement);
  const calls = Math.max(1, point.nextVersionCalls);
  const injected = (arm.injection?.turns ?? []).reduce(
    (sum, turn) =>
      sum +
      turn.tokens *
        (rate.cacheWrite + Math.max(0, turn.calls - 1) * rate.cacheRead),
    0,
  );
  return (
    arm.workerCostUsd +
    (replacement * (rate.cacheWrite + (calls - 1) * rate.cacheRead) +
      injected) /
      1_000_000
  );
}

/**
 * Experiment 1 cost: the whole prompt of every recorded call in the next
 * version, shifted by the arm's replacement and kept tail against
 * production's (recorded summary plus production tail). The first call
 * writes its prompt cold; each later call reads the previous prompt from
 * cache and writes its growth. Output is priced too, the same for all arms.
 * Growth and call counts come from the log, so a smaller tail does not get
 * the later compactions it would delay.
 */
export function totalVersionCost(
  point: CompactionPoint,
  arm: ArmContext,
): number {
  const tokens = (messages: readonly { tokens: number }[]) =>
    messages.reduce((sum, message) => sum + message.tokens, 0);
  const productionTail = tokens(point.tail);
  const shift =
    arm.tokens +
    (arm.tailTokens ?? productionTail) -
    estimateTextTokens(point.recordedSummary) -
    productionTail;
  const calls = point.nextVersionPrompts.length
    ? point.nextVersionPrompts
    : [{ prompt: point.details.replacementInputTokens, output: 0 }];
  let usd = arm.workerCostUsd;
  let previous = 0;
  calls.forEach((call, index) => {
    const prompt = Math.max(0, call.prompt + shift);
    const rate = rates(MODELS.opus, prompt);
    const cached = index ? Math.min(previous, prompt) : 0;
    usd +=
      (cached * rate.cacheRead +
        (prompt - cached) * rate.cacheWrite +
        call.output * rate.output) /
      1_000_000;
    previous = prompt;
  });
  const rate = rates(MODELS.opus, point.details.replacementInputTokens);
  for (const turn of arm.injection?.turns ?? []) {
    usd +=
      (turn.tokens *
        (rate.cacheWrite + Math.max(0, turn.calls - 1) * rate.cacheRead)) /
      1_000_000;
  }
  return usd;
}

/** Summed modeled cost and savings against the recorded summary. */
export function costSummary(
  points: readonly CompactionPoint[],
  arm: readonly ArmContext[],
  recorded: readonly ArmContext[],
) {
  let armUsd = 0;
  let recordedUsd = 0;
  for (const point of points) {
    const mine = arm.find((entry) => entry.point === point.index);
    const base = recorded.find((entry) => entry.point === point.index);
    if (!mine || !base) continue;
    armUsd += versionCost(point, mine);
    recordedUsd += versionCost(point, base);
  }
  return {
    armUsd,
    recordedUsd,
    savingsUsd: recordedUsd - armUsd,
    savingsRatio: recordedUsd ? (recordedUsd - armUsd) / recordedUsd : 0,
    workerUsd: arm.reduce((sum, entry) => sum + entry.workerCostUsd, 0),
    // Retrieval arms add their mean per-Turn injection to the fixed block.
    meanTokens:
      mean(
        arm.map(
          (entry) =>
            entry.tokens +
            (mean(entry.injection?.turns.map((turn) => turn.tokens) ?? []) ??
              0),
        ),
      ) ?? 0,
  };
}

/** A full pass: every expected fact present and no stale fact leaked. */
export function isPass(row: ProbeResult): boolean {
  return row.recall >= 1 && row.leaked === 0;
}

/**
 * Mean probe recall and full-pass rate for one arm, tier, and raw setting.
 * `points` limits rows to compaction points, for arms built at only some.
 */
export function probeRecall(
  results: readonly ProbeResult[],
  arm: string,
  tier: 1 | 2,
  withRaw: boolean,
  minAge = 0,
  points?: ReadonlySet<number>,
) {
  const rows = results.filter(
    (row) =>
      row.arm === arm &&
      row.tier === tier &&
      row.withRaw === withRaw &&
      row.age >= minAge &&
      (!points || points.has(row.point)),
  );
  return {
    n: rows.length,
    recall: mean(rows.map((row) => row.recall)),
    passRate: mean(rows.map((row) => (isPass(row) ? 1 : 0))),
    leaks: rows.reduce((sum, row) => sum + row.leaked, 0),
  };
}

/**
 * The frozen bar. Change it only before a scored run, and record the change
 * in the README; the report prints its hash.
 */
export const BAR = {
  minMargin: 0.1,
  spreadFactor: 2,
  decayMinAge: 5,
  maxCostFactor: 1.5,
} as const;

/** Wilson 95% interval for `passes` out of `n`. */
export function wilson(
  passes: number,
  n: number,
): [number | undefined, number | undefined] {
  if (!n) return [undefined, undefined];
  const z = 1.96;
  const p = passes / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * The agreed bar: a distillation arm beats the recorded summary on Tier 1
 * and Tier 2 probe recall by more than 10 points and more than twice the
 * rerun spread, in both raw settings; does no worse on facts at least five
 * compactions old; leaks no more stale facts; and its extra modeled cost
 * stays under 1.5x the recorded summary spend. Added from BYK/loreai#1211's
 * method, without changing those checks: the full-pass rate must clear the
 * same margin over recorded, and recall must clear the same margin over the
 * `empty` arm, the guessability floor.
 */
export function worthIt(args: {
  results: readonly ProbeResult[];
  arm: string;
  rerunSpread: number;
  extraUsd: number;
  recordedSummaryUsd: number;
  /** Recall baseline. Experiment 1 uses the summary at the same tail. */
  baseline?: string;
  floor?: string;
  /** Experiment 1: total modeled cost against today's setup replaces the spend check. */
  totalCostDeltaUsd?: number;
}) {
  const baseline = args.baseline ?? "recorded";
  const floorArm = args.floor ?? "empty";
  const margin = Math.max(BAR.minMargin, BAR.spreadFactor * args.rerunSpread);
  const checks: Record<string, boolean> = {};
  for (const withRaw of [false, true]) {
    for (const tier of [1, 2] as const) {
      const mine = probeRecall(args.results, args.arm, tier, withRaw);
      const base = probeRecall(args.results, baseline, tier, withRaw);
      checks[
        `tier${tier}${withRaw ? "+raw" : ""} +${Math.round(margin * 100)}pts`
      ] =
        mine.recall !== undefined &&
        base.recall !== undefined &&
        mine.recall - base.recall > margin;
      checks[`tier${tier}${withRaw ? "+raw" : ""} leaks`] =
        mine.leaks <= base.leaks;
      checks[
        `tier${tier}${withRaw ? "+raw" : ""} pass rate +${Math.round(margin * 100)}pts`
      ] =
        mine.passRate !== undefined &&
        base.passRate !== undefined &&
        mine.passRate - base.passRate > margin;
      const floor = probeRecall(args.results, floorArm, tier, withRaw);
      checks[`tier${tier}${withRaw ? "+raw" : ""} above empty floor`] =
        mine.recall !== undefined &&
        floor.recall !== undefined &&
        mine.recall - floor.recall > margin;
    }
    const old = probeRecall(
      args.results,
      args.arm,
      1,
      withRaw,
      BAR.decayMinAge,
    );
    const oldBase = probeRecall(
      args.results,
      baseline,
      1,
      withRaw,
      BAR.decayMinAge,
    );
    checks[`decay age>=${BAR.decayMinAge}${withRaw ? "+raw" : ""}`] =
      (old.recall ?? 0) >= (oldBase.recall ?? 0);
  }
  if (args.totalCostDeltaUsd === undefined) {
    checks[`cost <= ${BAR.maxCostFactor}x summary spend`] =
      args.extraUsd <= BAR.maxCostFactor * args.recordedSummaryUsd;
  } else {
    checks["total cost <= today"] = args.totalCostDeltaUsd <= 0;
  }
  return { pass: Object.values(checks).every(Boolean), checks };
}
