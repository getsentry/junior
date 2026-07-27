import type { AgentTurnUsage } from "@/chat/usage";

export const TURN_SPEND_LIMIT_RESPONSE =
  "I stopped this conversation because it reached its configured spend limit.";

/** Terminal failure raised when one agent turn reaches its configured USD cap. */
export class TurnSpendLimitExceededError extends Error {
  constructor(readonly maxSpendUsd: number) {
    super(`Agent turn reached spend limit ($${maxSpendUsd.toFixed(6)})`);
    this.name = "TurnSpendLimitExceededError";
  }
}

/** Terminal failure raised when a configured cap cannot verify provider spend. */
export class TurnSpendCostUnavailableError extends Error {
  constructor() {
    super("Agent turn provider usage omitted cost data");
    this.name = "TurnSpendCostUnavailableError";
  }
}

/** Return whether an error should stop the turn with the static spend-limit response. */
export function isTurnSpendLimitError(
  error: unknown,
): error is TurnSpendLimitExceededError | TurnSpendCostUnavailableError {
  return (
    error instanceof TurnSpendLimitExceededError ||
    error instanceof TurnSpendCostUnavailableError
  );
}

/** Return the provider-reported total USD cost, deriving it from components when needed. */
export function agentTurnCostUsd(usage: AgentTurnUsage | undefined): number {
  if (!usage?.cost) return 0;
  if (usage.cost.total !== undefined) return usage.cost.total;
  return (
    (usage.cost.input ?? 0) +
    (usage.cost.output ?? 0) +
    (usage.cost.cacheRead ?? 0) +
    (usage.cost.cacheWrite ?? 0)
  );
}

/** Throw once reported turn cost reaches the cap or cannot be verified. */
export function enforceTurnSpendLimit(args: {
  maxSpendUsd: number | undefined;
  usage: AgentTurnUsage | undefined;
}): void {
  if (args.maxSpendUsd === undefined || args.usage === undefined) {
    return;
  }
  if (!args.usage.cost || Object.keys(args.usage.cost).length === 0) {
    throw new TurnSpendCostUnavailableError();
  }
  if (agentTurnCostUsd(args.usage) >= args.maxSpendUsd) {
    throw new TurnSpendLimitExceededError(args.maxSpendUsd);
  }
}
