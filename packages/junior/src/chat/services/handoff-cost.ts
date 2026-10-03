import type { Model } from "@/chat/pi/sdk";

const MIN_SAVINGS = 0.2;
const USD_PER_MILLION_TOKENS = 1_000_000;

function rates(model: Model<any>, inputTokens: number) {
  return (
    model.cost.tiers
      ?.filter((tier) => inputTokens > tier.inputTokensAbove)
      .sort((a, b) => a.inputTokensAbove - b.inputTokensAbove)
      .at(-1) ?? model.cost
  );
}

/** Compare one cold handoff call and one cached follow-up with a fresh summary. */
export function shouldReuseHandoffHistory(args: {
  fastModel: Model<any>;
  rawTokens: number;
  replacementTokens: number;
  summaryInputTokens: number;
  summaryOutputTokens: number;
  targetModel: Model<any>;
}): boolean {
  const rawRates = rates(args.targetModel, args.rawTokens);
  const replacementRates = rates(args.targetModel, args.replacementTokens);
  const fastRates = rates(args.fastModel, args.summaryInputTokens);
  const rawWrite = rawRates.cacheWrite || rawRates.input;
  const replacementWrite =
    replacementRates.cacheWrite || replacementRates.input;
  const rawCost =
    (args.rawTokens * (rawWrite + rawRates.cacheRead)) / USD_PER_MILLION_TOKENS;
  const replacementCost =
    (args.replacementTokens * (replacementWrite + replacementRates.cacheRead) +
      args.summaryInputTokens * fastRates.input +
      args.summaryOutputTokens * fastRates.output) /
    USD_PER_MILLION_TOKENS;
  if (
    !Number.isFinite(rawCost) ||
    !Number.isFinite(replacementCost) ||
    rawCost < 0 ||
    replacementCost < 0
  ) {
    return false;
  }
  // Keep exact history on a close call. Summarize only for a clear saving.
  return replacementCost > rawCost * (1 - MIN_SAVINGS);
}
