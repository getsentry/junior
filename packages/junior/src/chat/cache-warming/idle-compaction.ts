/**
 * Compaction on idle: at a warmup slot of a large prefix, a ready background
 * summary can replace the history instead of a warmup.
 *
 * At or above the background compaction mark, a return to the full prefix
 * is close to the compaction threshold and can compact within its Turn, and each of its model calls reads
 * the full prefix. Swapping the summary in costs no model call, ends the
 * warmups, and the returning Turn reads a much smaller prefix. A return
 * before the cache expires reads the full prefix from the cache, which costs
 * less than a write of the compacted prefix. So the swap runs at a warmup
 * slot, not at the start of the idle period. This also gives the summary
 * that the last model call requested time to get ready.
 *
 * Each slot with a ready summary picks the cheapest of warm, compact, and
 * stop (`chooseIdleCompaction`). A likely quick return can warm first and
 * compact at a later slot.
 *
 * The tradeoff: a Conversation that returns gets the summary in place of
 * history that it would have kept in that Turn. `design/context-compaction.md`
 * owns the rule, the cost math, and that tradeoff.
 */
import { getChatConfig } from "@/chat/config";
import { logWarn } from "@/chat/logging";
import { getAgentBackgroundCompactionMarkTokens } from "@/chat/services/context-budget";
import { swapPreparedCompactionOnIdle } from "@/chat/services/context-compaction-swap";
import { withIdleConversation } from "@/chat/task-execution/store";
import type { IdleCompactionChoice, IdleCompactionChoiceResult } from "./model";

/**
 * `app.cache_warming.idle_compaction` of a warmup that tried to compact.
 * `applied`: the summary replaced the history, so the warmup skips with
 * `compacted_on_idle`. `deferred`: warming costs less for now, so the
 * warmup warms, and the next slot chooses again. `stopped`: neither pays,
 * so the warmup skips with `idle_compaction_stopped`. `not_ready`: no ready
 * summary, or it could not be used, such as one over the target. `busy`: a
 * Run holds the Conversation. `failed`: the swap threw. `not_ready`, `busy`,
 * and `failed` warm as before.
 */
type IdleCompactionOutcome =
  | "applied"
  | "deferred"
  | "stopped"
  | "not_ready"
  | "busy"
  | "failed";

/** What a warmup knows about the prefix of its idle period. */
interface IdleCompactionInput {
  conversationId: string;
  modelId: string;
  prefixTokens: number;
  /** Set when the idle period started at or above the mark. */
  requestOverheadTokens?: number;
  /** Choose what to do, given the estimated compacted prefix. */
  choose: (compactedTokens: number) => IdleCompactionChoiceResult;
}

/** Outcome of a warmup that tried to compact, with the costs it compared. */
interface IdleCompactionResult {
  outcome: IdleCompactionOutcome;
  costs?: IdleCompactionChoiceResult["costs"];
}

const CHOICE_OUTCOMES: Record<IdleCompactionChoice, IdleCompactionOutcome> = {
  compact: "applied",
  warm: "deferred",
  stop: "stopped",
};

/**
 * Return whether an idle period may try to compact instead of warming.
 * Below the mark, no background summary exists, and the cache costs little.
 */
export function mayCompactOnIdle(input: {
  modelId: string;
  prefixTokens: number;
}): boolean {
  return (
    input.prefixTokens >= getAgentBackgroundCompactionMarkTokens(input.modelId)
  );
}

/**
 * Swap a ready background summary into an idle Conversation in place of a
 * warmup, when `choose` picks compact. Return none when the idle period may
 * not try. A failure only loses the swap, so it is logged and the warmup
 * goes on.
 *
 * No warmup of the compacted prefix follows. That prefix is not in the
 * cache, so a warmup of it writes the cache instead of reading it. With the
 * warmup rule (`decideWarmup`), it pays when the returns per warmup are over
 * write/(write − read), which is more than 1. A return writes the prefix once
 * either way.
 */
export async function compactOnIdle(
  input: IdleCompactionInput,
): Promise<IdleCompactionResult | undefined> {
  const { requestOverheadTokens } = input;
  if (
    !getChatConfig().idleCompactionEnabled ||
    requestOverheadTokens === undefined ||
    !mayCompactOnIdle(input)
  ) {
    return undefined;
  }
  try {
    // A Run takes its lease before it reads the history. The swap keeps a
    // Run from taking it, so a returning Turn reads the full history or the
    // compacted one, never history that changes under it.
    let chosen: IdleCompactionChoiceResult | undefined;
    const result = await withIdleConversation(
      { conversationId: input.conversationId },
      (fence) =>
        swapPreparedCompactionOnIdle({
          beforeReplace: fence,
          conversationId: input.conversationId,
          modelId: input.modelId,
          requestOverheadTokens,
          shouldReplace: (compactedTokens) => {
            chosen = input.choose(compactedTokens);
            return chosen.choice === "compact";
          },
        }),
    );
    if (result === "busy") return { outcome: "busy" };
    if (!chosen) return { outcome: "not_ready" };
    // A conflict can stop a compact choice after it was made.
    if (chosen.choice === "compact" && !result.compacted) {
      return { outcome: "not_ready", costs: chosen.costs };
    }
    return { outcome: CHOICE_OUTCOMES[chosen.choice], costs: chosen.costs };
  } catch (error) {
    logWarn("cache_warming.idle_compaction.failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
    return { outcome: "failed" };
  }
}
