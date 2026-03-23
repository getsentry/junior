import { getConnectedStateContext } from "./adapter";

const QUEUE_INGRESS_DEDUP_PREFIX = "junior:queue_ingress";

function queueIngressDedupKey(rawKey: string): string {
  return `${QUEUE_INGRESS_DEDUP_PREFIX}:${rawKey}`;
}

export async function claimQueueIngressDedup(
  rawKey: string,
  ttlMs: number,
): Promise<boolean> {
  const { stateAdapter, redisStateAdapter } = await getConnectedStateContext();
  const key = queueIngressDedupKey(rawKey);
  if (redisStateAdapter) {
    const result = await redisStateAdapter.getClient().set(key, "1", {
      NX: true,
      PX: ttlMs,
    });
    return result === "OK";
  }
  return await stateAdapter.setIfNotExists(key, "1", ttlMs);
}

export async function hasQueueIngressDedup(rawKey: string): Promise<boolean> {
  const { stateAdapter, redisStateAdapter } = await getConnectedStateContext();
  const key = queueIngressDedupKey(rawKey);
  const value = redisStateAdapter
    ? await redisStateAdapter.getClient().get(key)
    : await stateAdapter.get(key);
  return typeof value === "string" && value.length > 0;
}
