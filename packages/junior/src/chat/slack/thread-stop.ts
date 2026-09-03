import type { StateAdapter, Thread } from "chat";
import { z } from "zod";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import { MUTATION_LOCK_TTL_MS, withLock } from "@/chat/state/locks";

const stopTimeSchema = z.number().finite();
const LOCK_WAIT_MS = 10_000;

function stopTimeKey(threadId: string): string {
  return `slack:thread-stop:${threadId}`;
}

function lockKey(threadId: string): string {
  return `slack:thread-stop-lock:${threadId}`;
}

async function getStopTime(
  state: StateAdapter,
  threadId: string,
): Promise<number | undefined> {
  const parsed = stopTimeSchema.safeParse(
    await state.get(stopTimeKey(threadId)),
  );
  return parsed.success ? parsed.data : undefined;
}

/** Record a Slack stop and unsubscribe while excluding a concurrent subscribe. */
export async function stopSlackThread(args: {
  state: StateAdapter;
  stoppedAtMs: number;
  thread: Thread;
}): Promise<void> {
  const result = await withLock(
    args.state,
    lockKey(args.thread.id),
    async () => {
      const current = await getStopTime(args.state, args.thread.id);
      await args.state.set(
        stopTimeKey(args.thread.id),
        Math.max(current ?? 0, args.stoppedAtMs),
        JUNIOR_THREAD_STATE_TTL_MS,
      );
      await args.thread.unsubscribe();
    },
    { ttlMs: MUTATION_LOCK_TTL_MS, waitMs: LOCK_WAIT_MS },
  );
  if (!result.acquired) {
    throw new Error(`Could not lock Slack stop state for ${args.thread.id}`);
  }
}

/** Subscribe for a mention unless a later Slack stop already opted out. */
export async function subscribeSlackThreadForMessage(args: {
  messageCreatedAtMs: number;
  state: StateAdapter;
  thread: Thread;
}): Promise<boolean> {
  const result = await withLock(
    args.state,
    lockKey(args.thread.id),
    async () => {
      const stoppedAtMs = await getStopTime(args.state, args.thread.id);
      if (stoppedAtMs !== undefined && args.messageCreatedAtMs <= stoppedAtMs) {
        return false;
      }
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
