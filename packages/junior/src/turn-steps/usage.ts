// What a core Turn spent on the model. The Turn's limits and its dashboard
// metrics both read it, so they count the same spend.
import { extractGenAiUsageSummary } from "@/chat/logging";
import type { PiMessage } from "@/chat/pi/messages";
import {
  addAgentTurnUsage,
  agentTurnCostUsd,
  type AgentTurnUsage,
} from "@/chat/usage";
import type { EngineContext } from "@/core/engine-context";
import { findDiscardedUsage } from "@/core/turn/state";
import { microUsdToUsd } from "@/db/micro-usd";

/**
 * Sums the usage of the model replies in `history`, the Turn's own history,
 * and of the replies that the Turn paid for but dropped.
 */
export async function turnUsage(
  ctx: Pick<EngineContext, "executor">,
  turnId: string,
  history: readonly PiMessage[],
): Promise<AgentTurnUsage> {
  const kept = extractGenAiUsageSummary(
    ...history.filter((message) => message.role === "assistant"),
  );
  const discarded = await findDiscardedUsage(ctx, turnId);
  const { cost: _, ...tokens } =
    addAgentTurnUsage(kept, discarded?.tokens) ?? {};
  const keptCostUsd = agentTurnCostUsd(kept);
  if (keptCostUsd === undefined && !discarded?.costMicroUsd) {
    return tokens;
  }
  return {
    ...tokens,
    cost: {
      total: (keptCostUsd ?? 0) + microUsdToUsd(discarded?.costMicroUsd ?? 0),
    },
  };
}
