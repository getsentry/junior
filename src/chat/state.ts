import { createMemoryState } from "@chat-adapter/state-memory";
import { createRedisState } from "@chat-adapter/state-redis";
import { hasRedisConfig } from "@/chat/config";

export function createStateAdapter() {
  if (hasRedisConfig()) {
    return createRedisState({
      url: process.env.REDIS_URL
    });
  }

  return createMemoryState();
}
