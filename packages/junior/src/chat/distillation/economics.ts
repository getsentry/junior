import type { Model } from "@/chat/pi/sdk";
import type { ConversationEvent } from "@/chat/conversations/history";

const USD_PER_MILLION_TOKENS = 1_000_000;
const MIN_SAVINGS = 0.2;

/** Use recent Turn activity to bound the model calls that may repay a write. */
export function expectedContextCalls(
  events: readonly ConversationEvent[],
): number {
  const completed =
    events.length -
    1 -
    [...events]
      .reverse()
      .findIndex((event) => event.data.type === "turn_completed");
  const started =
    events
      .slice(0, completed)
      .map((event, index) => ({ event, index }))
      .reverse()
      .find(({ event }) => event.data.type === "turn_started")?.index ?? -1;
  const previousCalls = events
    .slice(started + 1, completed)
    .filter((event) => event.data.type === "assistant_message").length;
  return Math.min(12, Math.max(2, previousCalls * 2));
}

function rates(model: Model<any>, inputTokens: number) {
  return (
    model.cost.tiers
      ?.filter((tier) => inputTokens > tier.inputTokensAbove)
      .sort((a, b) => a.inputTokensAbove - b.inputTokensAbove)
      .at(-1) ?? model.cost
  );
}

/** Price a cold replacement against keeping the current cached history. */
export function distillationSavings(args: {
  model: Model<any>;
  rawTokens: number;
  replacementTokens: number;
  expectedCalls: number;
  rawCacheWarm: boolean;
  workerCostUsd: number;
}): { savingsUsd: number; savingsRatio: number } | undefined {
  const values = [
    args.rawTokens,
    args.replacementTokens,
    args.expectedCalls,
    args.workerCostUsd,
  ];
  if (
    values.some((value) => !Number.isFinite(value) || value < 0) ||
    args.expectedCalls < 1 ||
    args.replacementTokens >= args.rawTokens
  ) {
    return undefined;
  }

  const raw = rates(args.model, args.rawTokens);
  const replacement = rates(args.model, args.replacementTokens);
  const rawRead = raw.cacheRead || raw.input;
  const rawWrite = raw.cacheWrite || raw.input;
  const replacementRead = replacement.cacheRead || replacement.input;
  const replacementWrite = replacement.cacheWrite || replacement.input;
  const rawCost =
    (args.rawTokens * (args.rawCacheWarm ? rawRead : rawWrite) +
      args.rawTokens * (args.expectedCalls - 1) * rawRead) /
    USD_PER_MILLION_TOKENS;
  const replacementCost =
    args.workerCostUsd +
    (args.replacementTokens *
      (replacementWrite + (args.expectedCalls - 1) * replacementRead)) /
      USD_PER_MILLION_TOKENS;
  if (
    !Number.isFinite(rawCost) ||
    !Number.isFinite(replacementCost) ||
    rawCost <= 0 ||
    replacementCost < 0
  ) {
    return undefined;
  }
  return {
    savingsUsd: rawCost - replacementCost,
    savingsRatio: (rawCost - replacementCost) / rawCost,
  };
}

/** Require a material modeled saving before paying to rewrite a warm prefix. */
export function shouldUseDistillations(
  args: Parameters<typeof distillationSavings>[0],
): boolean {
  const result = distillationSavings(args);
  return result !== undefined && result.savingsRatio >= MIN_SAVINGS;
}

/** Price an uncached Luna observation or consolidation call. */
export function estimateWorkerCost(args: {
  model: Model<any>;
  inputTokens: number;
  outputTokens: number;
}): number {
  const input = rates(args.model, args.inputTokens);
  return (
    (args.inputTokens * input.input + args.outputTokens * input.output) /
    USD_PER_MILLION_TOKENS
  );
}
