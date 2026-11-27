// The dashboard metrics of a core Turn: its duration, tokens and cost, with
// the Turn as the Run. People spend reads the Turn's person from these rows.
import { replaceConversationMetrics } from "@/chat/conversations/metrics";
import type { EngineContext } from "@/core/engine-context";
import { loadTurnAgentHistory } from "@/core/history/read";
import { findTurnActor } from "@/core/turn/inbox";
import { findTurn } from "@/core/turn/state";
import { turnUsage } from "@/turn-steps/usage";

/**
 * Writes the metrics of an ended Turn. A rerun replaces the same rows, so a
 * Turn counts once however often its Turn-ended message arrives. A Turn that
 * never ran or has not ended writes nothing.
 */
export async function recordTurnMetrics(
  ctx: Pick<EngineContext, "executor">,
  message: { conversationId: string; turnId: string },
): Promise<void> {
  const turn = await findTurn(ctx, message.turnId);
  if (!turn?.startedAt || !turn.endedAt) {
    return;
  }
  const [history, actorIdentityId] = await Promise.all([
    loadTurnAgentHistory(ctx, message.turnId),
    findTurnActor(ctx, message.turnId),
  ]);
  const usage = await turnUsage(ctx, message.turnId, history);
  const { startedAt, endedAt } = turn;
  await ctx.executor.transaction(() =>
    replaceConversationMetrics(ctx.executor, {
      actorIdentityId,
      conversationId: message.conversationId,
      runId: message.turnId,
      occurredAtMs: startedAt.getTime(),
      updatedAtMs: endedAt.getTime(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      usage,
    }),
  );
}
