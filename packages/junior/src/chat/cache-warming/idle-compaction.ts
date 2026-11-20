/**
 * Compaction on idle: a warmup of a large prefix swaps in a ready background
 * summary instead of refreshing the cache.
 *
 * At or above the background compaction mark, a return to the full prefix
 * often compacts within its Turn anyway, and each of its model calls reads
 * the full prefix. Swapping the summary in costs no model call, ends the
 * warmups, and the returning Turn reads a much smaller prefix. A return
 * before the cache expires reads the full prefix from the cache, which costs
 * less than a write of the compacted prefix. So the swap waits for the
 * warmup, not for the start of the idle period. This also gives the summary
 * that the last model call requested time to get ready.
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

/**
 * `app.cache_warming.idle_compaction` of a warmup that tried to compact.
 * `applied`: the summary replaced the history, so the warmup skips with
 * `compacted_on_idle`. `not_ready`: no ready summary, or it could not be
 * used, such as one over the target. `busy`: a Run holds the Conversation.
 * `failed`: the swap threw. All but `applied` warm as before.
 */
type IdleCompactionOutcome = "applied" | "not_ready" | "busy" | "failed";

/** What a warmup knows about the prefix of its idle period. */
interface IdleCompactionInput {
  conversationId: string;
  modelId: string;
  prefixTokens: number;
  /** Set when the idle period started at or above the mark. */
  requestOverheadTokens?: number;
}

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
 * warmup. Return none when the idle period may not try. A failure only
 * loses the swap, so it is logged and the warmup goes on.
 *
 * No warmup of the compacted prefix follows. That prefix is not in the
 * cache, so a warmup of it writes the cache instead of reading it. With the
 * warmup rule (`decideWarmup`), it pays when the returns per warmup are over
 * write/(write − read), which is more than 1. A return writes the prefix once
 * either way.
 */
export async function compactOnIdle(
  input: IdleCompactionInput,
): Promise<IdleCompactionOutcome | undefined> {
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
    const result = await withIdleConversation(
      { conversationId: input.conversationId },
      (fence) =>
        swapPreparedCompactionOnIdle({
          beforeReplace: fence,
          conversationId: input.conversationId,
          modelId: input.modelId,
          requestOverheadTokens,
        }),
    );
    if (result === "busy") return "busy";
    return result.compacted ? "applied" : "not_ready";
  } catch (error) {
    logWarn("cache_warming.idle_compaction.failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}
