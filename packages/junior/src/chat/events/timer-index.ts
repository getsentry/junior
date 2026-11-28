import type { StateAdapter } from "chat";
import * as z from "zod";
import { getChatConfig } from "@/chat/config";
import { getDefaultRedisStateAdapterFor } from "@/chat/state/adapter";

/**
 * A sorted set of pending timers: ids with their fire times. Claims move a
 * score forward, so a crashed heartbeat leaves work available after a short
 * lease. `batchSize` bounds one claim.
 */
export interface TimerIndex {
  batchSize: number;
  key: string;
}

/** Pending timer Watches. */
export const TIMER_WATCH_INDEX: TimerIndex = {
  batchSize: 25,
  key: "junior:watches:due",
};

const CLAIM_MS = 120_000;
const entriesSchema = z.array(z.object({ id: z.string(), atMs: z.number() }));

type Operation =
  | { kind: "add"; id: string; atMs: number }
  | { kind: "remove"; id: string }
  | { kind: "claim"; nowMs: number };

function redisKey(index: TimerIndex): string {
  const prefix = getChatConfig().state.keyPrefix;
  return prefix ? `${prefix}:${index.key}` : index.key;
}

/** Keep timer index operations atomic in Redis and the local memory adapter. */
export async function updateTimerIndex(
  state: StateAdapter,
  index: TimerIndex,
  operation: Operation,
): Promise<string[]> {
  const redis = await getDefaultRedisStateAdapterFor(state);
  if (redis) {
    const key = redisKey(index);
    const client = redis.getClient();
    if (operation.kind === "add") {
      await client.sendCommand([
        "ZADD",
        key,
        String(operation.atMs),
        operation.id,
      ]);
      return [];
    }
    if (operation.kind === "remove") {
      await client.sendCommand(["ZREM", key, operation.id]);
      return [];
    }
    return await client.sendCommand<string[]>([
      "EVAL",
      `local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[3])
       for _, id in ipairs(ids) do
         redis.call('ZADD', KEYS[1], ARGV[2], id)
       end
       return ids`,
      "1",
      key,
      String(operation.nowMs),
      String(operation.nowMs + CLAIM_MS),
      String(index.batchSize),
    ]);
  }

  // Production uses the sorted set above. The local adapter has no sorted sets.
  const lock = await state.acquireLock(`${index.key}:lock`, 10_000);
  if (!lock) throw new Error("Could not acquire timer index lock");
  try {
    let entries = entriesSchema.parse((await state.get(index.key)) ?? []);
    let ids: string[] = [];
    if (operation.kind === "claim") {
      ids = entries
        .filter((entry) => entry.atMs <= operation.nowMs)
        .sort((a, b) => a.atMs - b.atMs)
        .slice(0, index.batchSize)
        .map((entry) => entry.id);
      const claimed = new Set(ids);
      entries = entries.map((entry) =>
        claimed.has(entry.id)
          ? { ...entry, atMs: operation.nowMs + CLAIM_MS }
          : entry,
      );
    } else {
      entries = entries.filter((entry) => entry.id !== operation.id);
      if (operation.kind === "add") {
        entries.push({ id: operation.id, atMs: operation.atMs });
      }
    }
    await state.set(index.key, entries);
    return ids;
  } finally {
    await state.releaseLock(lock);
  }
}

/**
 * Read when each of these timers fires, by id. A claimed timer reads its
 * claim lease, and a fired or unknown timer is left out.
 */
export async function readTimerIndex(
  state: StateAdapter,
  index: TimerIndex,
  ids: readonly string[],
): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  if (ids.length === 0) return times;
  const redis = await getDefaultRedisStateAdapterFor(state);
  if (redis) {
    const key = redisKey(index);
    const scores = await redis
      .getClient()
      .sendCommand<(string | null)[]>(["ZMSCORE", key, ...ids]);
    for (const [position, id] of ids.entries()) {
      const score = scores[position];
      if (score != null) times.set(id, Number(score));
    }
    return times;
  }
  const wanted = new Set(ids);
  for (const entry of entriesSchema.parse((await state.get(index.key)) ?? [])) {
    if (wanted.has(entry.id)) times.set(entry.id, entry.atMs);
  }
  return times;
}
