import { toOptionalTrimmed } from "@/chat/optional-string";

/** Which queue delivers background work. */
export type QueueConfig =
  | { provider: "vercel" }
  | { provider: "bullmq"; redisUrl: string };

/** Read queue settings from environment variables. */
export function readQueueConfig(env: NodeJS.ProcessEnv): QueueConfig {
  const provider = toOptionalTrimmed(env.JUNIOR_QUEUE_PROVIDER) ?? "vercel";
  switch (provider) {
    case "vercel":
      return { provider };
    case "bullmq": {
      const redisUrl = toOptionalTrimmed(env.JUNIOR_QUEUE_REDIS_URL);
      if (!redisUrl) {
        throw new Error(
          "JUNIOR_QUEUE_REDIS_URL is required when JUNIOR_QUEUE_PROVIDER is bullmq",
        );
      }
      return { provider, redisUrl };
    }
    default:
      throw new Error("JUNIOR_QUEUE_PROVIDER must be vercel or bullmq");
  }
}
