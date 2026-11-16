import { estimateTextTokens } from "@/chat/services/token-estimate";
import type { ArmContext, Tier2Item } from "./arms";
import type { CompactionPoint } from "./history";
import { MODELS, rates } from "./models";
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
) {
  const norms = new Map(
    arm.map((context) => [context.point, normalizeForMatch(context.context)]),
  );
  const hits = facts.map((fact) => {
    const context = arm.find((entry) => entry.point === fact.point);
    return {
      fact,
      hit: context
        ? factIn(fact, context.context, norms.get(fact.point))
        : false,
    };
  });
  const recall = (rows: typeof hits) =>
    mean(rows.map((row) => (row.hit ? 1 : 0)));
  const group = (key: (fact: Tier1Fact) => string) => {
    const result: Record<string, { n: number; recall: number | undefined }> =
      {};
    for (const value of new Set(facts.map(key))) {
      const rows = hits.filter((row) => key(row.fact) === value);
      result[value] = { n: rows.length, recall: recall(rows) };
    }
    return result;
  };
  return {
    n: facts.length,
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
 * arm, so only the replacement size differs.
 */
export function versionCost(point: CompactionPoint, arm: ArmContext): number {
  const replacement =
    point.details.replacementInputTokens -
    estimateTextTokens(point.recordedSummary) +
    arm.tokens;
  const rate = rates(MODELS.opus, replacement);
  const calls = Math.max(1, point.nextVersionCalls);
  return (
    arm.workerCostUsd +
    (replacement * (rate.cacheWrite + (calls - 1) * rate.cacheRead)) / 1_000_000
  );
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
    meanTokens: mean(arm.map((entry) => entry.tokens)) ?? 0,
  };
}

/** Mean probe recall for one arm, tier, and raw setting. */
export function probeRecall(
  results: readonly ProbeResult[],
  arm: string,
  tier: 1 | 2,
  withRaw: boolean,
  minAge = 0,
) {
  const rows = results.filter(
    (row) =>
      row.arm === arm &&
      row.tier === tier &&
      row.withRaw === withRaw &&
      row.age >= minAge,
  );
  return {
    n: rows.length,
    recall: mean(rows.map((row) => row.recall)),
    leaks: rows.reduce((sum, row) => sum + row.leaked, 0),
  };
}

/**
 * The agreed bar: a distillation arm beats the recorded summary on Tier 1
 * and Tier 2 probe recall by more than 10 points and more than twice the
 * rerun spread, in both raw settings; does no worse on facts at least five
 * compactions old; leaks no more stale facts; and its extra modeled cost
 * stays under 1.5x the recorded summary spend.
 */
export function worthIt(args: {
  results: readonly ProbeResult[];
  arm: string;
  rerunSpread: number;
  extraUsd: number;
  recordedSummaryUsd: number;
}) {
  const margin = Math.max(0.1, 2 * args.rerunSpread);
  const checks: Record<string, boolean> = {};
  for (const withRaw of [false, true]) {
    for (const tier of [1, 2] as const) {
      const mine = probeRecall(args.results, args.arm, tier, withRaw);
      const base = probeRecall(args.results, "recorded", tier, withRaw);
      checks[
        `tier${tier}${withRaw ? "+raw" : ""} +${Math.round(margin * 100)}pts`
      ] =
        mine.recall !== undefined &&
        base.recall !== undefined &&
        mine.recall - base.recall > margin;
      checks[`tier${tier}${withRaw ? "+raw" : ""} leaks`] =
        mine.leaks <= base.leaks;
    }
    const old = probeRecall(args.results, args.arm, 1, withRaw, 5);
    const oldBase = probeRecall(args.results, "recorded", 1, withRaw, 5);
    checks[`decay age>=5${withRaw ? "+raw" : ""}`] =
      (old.recall ?? 0) >= (oldBase.recall ?? 0);
  }
  checks["cost <= 1.5x summary spend"] =
    args.extraUsd <= 1.5 * args.recordedSummaryUsd;
  return { pass: Object.values(checks).every(Boolean), checks };
}
