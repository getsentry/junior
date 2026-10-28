import type { StateAdapter } from "chat";
import { z } from "zod";
import { getChatConfig } from "@/chat/config";
import { getDefaultRedisStateAdapterFor } from "@/chat/state/adapter";

// Only pending timer Watches belong here. Claims move their score forward so
// a crashed heartbeat leaves work available after a short lease.
const DUE_KEY = "junior:watches:due";
const CLAIM_MS = 120_000;
const BATCH_SIZE = 25;
const entriesSchema = z.array(z.object({ id: z.string(), atMs: z.number() }));

type Operation =
  | { kind: "add"; id: string; atMs: number }
  | { kind: "remove"; id: string }
  | { kind: "claim"; nowMs: number };

/** Keep timer index operations atomic in Redis and the local memory adapter. */
export async function updateTimerIndex(
  state: StateAdapter,
  operation: Operation,
): Promise<string[]> {
  const redis = await getDefaultRedisStateAdapterFor(state);
  if (redis) {
    const prefix = getChatConfig().state.keyPrefix;
    const key = prefix ? `${prefix}:${DUE_KEY}` : DUE_KEY;
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
      String(BATCH_SIZE),
    ]);
  }

  // Production uses the sorted set above. The local adapter has no sorted sets.
  const lock = await state.acquireLock(`${DUE_KEY}:lock`, 10_000);
  if (!lock) throw new Error("Could not acquire timer index lock");
  try {
    let entries = entriesSchema.parse((await state.get(DUE_KEY)) ?? []);
    let ids: string[] = [];
    if (operation.kind === "claim") {
      ids = entries
        .filter((entry) => entry.atMs <= operation.nowMs)
        .sort((a, b) => a.atMs - b.atMs)
        .slice(0, BATCH_SIZE)
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
    await state.set(DUE_KEY, entries);
    return ids;
  } finally {
    await state.releaseLock(lock);
  }
}
