/**
 * Context compaction telemetry.
 *
 * Each compaction gets one `agent.context_compaction` span. The span and its
 * children, such as the summary `gen_ai.chat` span, carry
 * `app.compaction.mode`. The `chat.turn` span sums the time that the Turn
 * waited on compaction, with summary calls and prepared-summary swaps apart.
 *
 * Attribute keys do not contain "token": Sentry data scrubbing removes the
 * values of keys that match it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { runWithLogAttributes } from "@/chat/log-context";
import { logInfo, withSpan, type SetSpanAttributes } from "@/chat/logging";

/**
 * Where a compaction runs: `blocking` at Turn start, `active` between model
 * calls in a Turn, `background` in a job after a Turn.
 */
export type CompactionMode = "blocking" | "active" | "background";

/**
 * `summary` may call the model. `swap` only checks for a prepared summary,
 * waits for a running one, and swaps it in, so its wait is apart from summary
 * calls.
 */
type CompactionWork = "summary" | "swap";

type TurnCompactionWait = Record<CompactionWork, number>;

const turnCompactionWait = new AsyncLocalStorage<TurnCompactionWait>();

/** Run one compaction in its span and add its time to the Turn wait. */
export async function withCompactionSpan<T>(
  mode: CompactionMode,
  work: CompactionWork,
  callback: () => Promise<T>,
): Promise<T> {
  const startedAtMs = performance.now();
  try {
    return await runWithLogAttributes({ "app.compaction.mode": mode }, () =>
      withSpan(
        "agent.context_compaction",
        "agent.context_compaction",
        {},
        callback,
      ),
    );
  } finally {
    // A background job runs outside a Turn, so it has no Turn wait.
    const wait = turnCompactionWait.getStore();
    if (wait) {
      wait[work] += performance.now() - startedAtMs;
    }
  }
}

/** Run one `chat.turn` callback and record its compaction wait, if any. */
export async function measureTurnCompactionWait<T>(
  setTurnAttributes: SetSpanAttributes,
  callback: () => Promise<T>,
): Promise<T> {
  const wait: TurnCompactionWait = { summary: 0, swap: 0 };
  try {
    return await turnCompactionWait.run(wait, callback);
  } finally {
    setTurnAttributes({
      ...(wait.summary > 0
        ? { "app.turn.compaction_wait_ms": Math.round(wait.summary) }
        : undefined),
      ...(wait.swap > 0
        ? { "app.turn.compaction_swap_wait_ms": Math.round(wait.swap) }
        : undefined),
    });
  }
}

/**
 * Log the provider-reported input of the first model request after a
 * replacement. It shows when the replacement was still above the threshold.
 */
export function logInputAfterCompaction(args: {
  inputSize: number;
  mode: CompactionMode;
  threshold: number;
}): void {
  logInfo("context_compaction.next_request.completed", {
    "app.compaction.mode": args.mode,
    "app.compaction.next_input.size": args.inputSize,
    "app.compaction.next_input.over_threshold": args.inputSize > args.threshold,
    "app.compaction.threshold": args.threshold,
  });
}
