import type { StateAdapter, Thread } from "chat";
import { z } from "zod";
import { logException } from "@/chat/logging";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import { MUTATION_LOCK_TTL_MS, withLock } from "@/chat/state/locks";

const watermarksSchema = z
  .object({
    mentionAtMs: z.number().finite().optional(),
    stopAtMs: z.number().finite().optional(),
  })
  .strict();
type Watermarks = z.output<typeof watermarksSchema>;

const LOCK_WAIT_MS = 10_000;

function watermarksKey(threadId: string): string {
  return `slack:thread-stop:${threadId}`;
}

function lockKey(threadId: string): string {
  return `slack:thread-stop-lock:${threadId}`;
}

async function getWatermarks(
  state: StateAdapter,
  threadId: string,
): Promise<Watermarks> {
  const parsed = watermarksSchema.safeParse(
    await state.get(watermarksKey(threadId)),
  );
  return parsed.success ? parsed.data : {};
}

/**
 * Record a Slack stop and unsubscribe, unless a later mention already
 * re-subscribed. Returns `applied: false` for a stale/late-arriving stop
 * (a newer mention already re-subscribed) or a lock timeout, so the caller
 * skips cancelling a Turn and skips every other stop side effect.
 *
 * `stopAtMs` only ever moves forward: out-of-order redelivery of an older
 * or duplicate stop cannot un-apply a newer one, and a stop that is not
 * newer than the current `stopAtMs` is a no-op so it cannot re-trigger
 * cancel/ack side effects for a Turn a later mention already owns.
 */
export async function stopSlackThread(args: {
  state: StateAdapter;
  stoppedAtMs: number;
  thread: Thread;
}): Promise<{ applied: boolean }> {
  const result = await withLock(
    args.state,
    lockKey(args.thread.id),
    async () => {
      const current = await getWatermarks(args.state, args.thread.id);
      if (
        (current.mentionAtMs !== undefined &&
          current.mentionAtMs > args.stoppedAtMs) ||
        (current.stopAtMs !== undefined && current.stopAtMs >= args.stoppedAtMs)
      ) {
        return false;
      }
      await args.state.set(
        watermarksKey(args.thread.id),
        {
          ...current,
          stopAtMs: args.stoppedAtMs,
        } satisfies Watermarks,
        JUNIOR_THREAD_STATE_TTL_MS,
      );
      await args.thread.unsubscribe();
      return true;
    },
    { ttlMs: MUTATION_LOCK_TTL_MS, waitMs: LOCK_WAIT_MS },
  );
  if (!result.acquired) {
    logException(
      new Error(`Could not lock Slack stop state for ${args.thread.id}`),
      "slack.thread_stop.lock_failed",
    );
    return { applied: false };
  }
  return { applied: result.value };
}

/**
 * Subscribe for a mention unless a later Slack stop already opted out.
 *
 * `mentionAtMs` only ever moves forward: out-of-order redelivery of an
 * older mention cannot rewind the watermark a concurrent stop checks
 * against.
 */
export async function subscribeSlackThreadForMessage(args: {
  messageCreatedAtMs: number;
  state: StateAdapter;
  thread: Thread;
}): Promise<boolean> {
  const result = await withLock(
    args.state,
    lockKey(args.thread.id),
    async () => {
      const current = await getWatermarks(args.state, args.thread.id);
      if (
        current.stopAtMs !== undefined &&
        current.stopAtMs >= args.messageCreatedAtMs
      ) {
        return false;
      }
      await args.state.set(
        watermarksKey(args.thread.id),
        {
          ...current,
          mentionAtMs: Math.max(
            current.mentionAtMs ?? -Infinity,
            args.messageCreatedAtMs,
          ),
        } satisfies Watermarks,
        JUNIOR_THREAD_STATE_TTL_MS,
      );
      await args.thread.subscribe();
      return true;
    },
    { ttlMs: MUTATION_LOCK_TTL_MS, waitMs: LOCK_WAIT_MS },
  );
  if (!result.acquired) {
    throw new Error(`Could not lock Slack stop state for ${args.thread.id}`);
  }
  return result.value;
}
