import { createRedisState } from "@chat-adapter/state-redis";
import { hasRedisConfig } from "@/chat/config";

export function createStateAdapter() {
  if (!hasRedisConfig()) {
    throw new Error("REDIS_URL is required for durable Slack thread state");
  }

  return createRedisState({
    url: process.env.REDIS_URL
  });
}
