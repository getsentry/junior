/**
 * Context compaction telemetry.
 *
 * Each compaction gets one `agent.context_compaction` span. The span and its
 * children, such as the summary `gen_ai.chat` span, carry
 * `app.compaction.mode`. The `chat.turn` span sums the time that the Turn
 * waited on compaction.
 *
 * Attribute keys do not contain "token": Sentry data scrubbing removes the
 * values of keys that match it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { runWithLogAttributes } from "@/chat/log-context";
import { withSpan, type SetSpanAttributes } from "@/chat/logging";

/**
 * Where a compaction runs: `blocking` at Turn start, `active` between model
 * calls in a Turn, `handoff` for a model handoff.
 */
export type CompactionMode = "blocking" | "active" | "handoff";

interface TurnCompactionWait {
  ms: number;
}

const turnCompactionWait = new AsyncLocalStorage<TurnCompactionWait>();

/** Run one compaction in its span and add its time to the Turn wait. */
export async function withCompactionSpan<T>(
  mode: CompactionMode,
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
    // Every mode runs on the critical path of the Turn today.
    const wait = turnCompactionWait.getStore();
    if (wait) {
      wait.ms += performance.now() - startedAtMs;
    }
  }
}

/** Run one `chat.turn` callback and record its compaction wait, if any. */
export async function measureTurnCompactionWait<T>(
  setTurnAttributes: SetSpanAttributes,
  callback: () => Promise<T>,
): Promise<T> {
  const wait: TurnCompactionWait = { ms: 0 };
  try {
    return await turnCompactionWait.run(wait, callback);
  } finally {
    if (wait.ms > 0) {
      setTurnAttributes({
        "app.turn.compaction_wait_ms": Math.round(wait.ms),
      });
    }
  }
}
