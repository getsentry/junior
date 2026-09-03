import type { StateAdapter, Thread } from "chat";
import { z } from "zod";
import { logException } from "@/chat/logging";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import { MUTATION_LOCK_TTL_MS, withLock } from "@/chat/state/locks";

const eventKindSchema = z.enum(["mention", "stop"]);
const lastEventSchema = z
  .object({
    atMs: z.number().finite(),
    kind: eventKindSchema,
  })
  .strict();
type LastEvent = z.output<typeof lastEventSchema>;

const LOCK_WAIT_MS = 10_000;

function lastEventKey(threadId: string): string {
  return `slack:thread-stop:${threadId}`;
}

function lockKey(threadId: string): string {
  return `slack:thread-stop-lock:${threadId}`;
}

async function getLastEvent(
  state: StateAdapter,
  threadId: string,
): Promise<LastEvent | undefined> {
  const parsed = lastEventSchema.safeParse(
    await state.get(lastEventKey(threadId)),
  );
  return parsed.success ? parsed.data : undefined;
}

/**
 * Record a Slack stop and unsubscribe, unless a later mention already
 * re-subscribed. Returns `applied: false` for a stale/late-arriving stop so
 * the caller skips cancelling a Turn that a newer mention owns.
 *
 * A lock timeout cannot tell which event is newest, so it favors safety:
 * treat the stop as applied and let the caller still cancel the active Turn.
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
      const current = await getLastEvent(args.state, args.thread.id);
      if (current && current.atMs > args.stoppedAtMs) {
        return false;
      }
      await args.state.set(
        lastEventKey(args.thread.id),
        { atMs: args.stoppedAtMs, kind: "stop" } satisfies LastEvent,
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
    return { applied: true };
  }
  return { applied: result.value };
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
      const current = await getLastEvent(args.state, args.thread.id);
      if (
        current &&
        current.kind === "stop" &&
        current.atMs >= args.messageCreatedAtMs
      ) {
        return false;
      }
      await args.state.set(
        lastEventKey(args.thread.id),
        { atMs: args.messageCreatedAtMs, kind: "mention" } satisfies LastEvent,
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
