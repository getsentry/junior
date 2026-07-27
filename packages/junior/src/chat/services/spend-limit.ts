import type { AgentTurnUsage } from "@/chat/usage";

/** Terminal failure raised when one agent turn reaches its configured USD cap. */
export class TurnSpendLimitExceededError extends Error {
  constructor(readonly maxSpendUsd: number) {
    super(`Agent turn reached spend limit ($${maxSpendUsd.toFixed(6)})`);
    this.name = "TurnSpendLimitExceededError";
  }
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

/** Throw once reported turn cost reaches the configured hard cap. */
export function enforceTurnSpendLimit(args: {
  maxSpendUsd: number | undefined;
  usage: AgentTurnUsage | undefined;
}): void {
  if (
    args.maxSpendUsd !== undefined &&
    agentTurnCostUsd(args.usage) >= args.maxSpendUsd
  ) {
    throw new TurnSpendLimitExceededError(args.maxSpendUsd);
  }
}
